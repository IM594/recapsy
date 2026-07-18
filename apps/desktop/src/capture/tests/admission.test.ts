import { describe, expect, it } from 'bun:test';
import type { BackpressureConfig, OperationalStoreSnapshot } from '../../storage/index';
import { createCaptureAdmissionController } from '../admission';

const backpressure: BackpressureConfig = {
  maxAssetBytes: 600,
  maxQueuedJobs: 6,
  maxRetryingJobs: 3,
  resumeAssetBytes: 200,
  resumeQueuedJobs: 2,
  resumeRetryingJobs: 1,
};

describe('capture admission controller', () => {
  it('pauses at a high water mark and resumes only after every low water mark is clear', async () => {
    const lifecycle = new RecordingLifecycle();
    const store = new SnapshotStore({ assetBytes: 100, queuedJobs: 6, retryingJobs: 0 });
    const controller = createCaptureAdmissionController({
      backpressure,
      lifecycle,
      store,
      workspaceId: 'workspace_1',
    });

    await controller.reconcile();
    store.snapshot = { assetBytes: 400, queuedJobs: 2, retryingJobs: 0 };
    await controller.reconcile();
    store.snapshot = { assetBytes: 200, queuedJobs: 2, retryingJobs: 0 };
    await controller.reconcile();

    expect(lifecycle.automaticPauseCalls).toEqual([true, false]);
  });

  it('observes active retry-wait jobs independently and clears only at the retry low water mark', async () => {
    const lifecycle = new RecordingLifecycle();
    const store = new SnapshotStore({ assetBytes: 0, queuedJobs: 1, retryingJobs: 3 });
    const controller = createCaptureAdmissionController({
      backpressure,
      lifecycle,
      store,
      workspaceId: 'workspace_1',
    });

    await expect(controller.reconcile()).resolves.toEqual({
      active: true,
      reasons: ['max_retrying_jobs_reached'],
    });
    store.snapshot = { assetBytes: 0, queuedJobs: 1, retryingJobs: 2 };
    await controller.reconcile();
    store.snapshot = { assetBytes: 0, queuedJobs: 1, retryingJobs: 1 };
    await expect(controller.reconcile()).resolves.toEqual({ active: false, reasons: [] });

    expect(lifecycle.automaticPauseCalls).toEqual([true, false]);
  });

  it('latches low physical capacity until the independently injected disk signal reaches its resume water mark', async () => {
    const lifecycle = new RecordingLifecycle();
    const store = new SnapshotStore({ assetBytes: 0, queuedJobs: 0, retryingJobs: 0 });
    const storage = new StorageProbe({ availableBytes: 100, writable: true });
    const controller = createCaptureAdmissionController({
      backpressure,
      lifecycle,
      storage: {
        minAvailableBytes: 100,
        probe: storage.probe,
        resumeAvailableBytes: 200,
        verifyWrite: async () => undefined,
      },
      store,
      workspaceId: 'workspace_1',
    });

    await expect(controller.reconcile()).resolves.toEqual({
      active: true,
      reasons: ['min_available_storage_reached'],
    });
    storage.snapshot = { availableBytes: 150, writable: true };
    await controller.reconcile();
    storage.snapshot = { availableBytes: 200, writable: true };
    await expect(controller.reconcile()).resolves.toEqual({ active: false, reasons: [] });

    expect(lifecycle.storagePauseCalls).toEqual([true, false]);
  });

  it('does not write a recovery probe without both an intake failure and recovered capacity', async () => {
    const lifecycle = new RecordingLifecycle();
    const store = new SnapshotStore({ assetBytes: 0, queuedJobs: 0, retryingJobs: 0 });
    const storage = new StorageProbe({ availableBytes: 200, writable: true });
    let assetWriteVerifications = 0;
    let operationalWriteVerifications = 0;
    store.verifyOperationalWrite = async () => {
      operationalWriteVerifications += 1;
    };
    const controller = createCaptureAdmissionController({
      backpressure,
      lifecycle,
      storage: {
        minAvailableBytes: 100,
        probe: storage.probe,
        resumeAvailableBytes: 200,
        verifyWrite: async () => {
          assetWriteVerifications += 1;
        },
      },
      store,
      workspaceId: 'workspace_1',
    });

    await controller.reconcile();
    storage.snapshot = { availableBytes: 150, writable: true };
    await controller.reportStorageFailure();
    await controller.reconcile();
    await controller.reconcile();

    expect(controller.getStatus()).toEqual({
      active: true,
      reasons: ['storage_state_unavailable'],
    });
    expect(operationalWriteVerifications).toBe(0);
    expect(assetWriteVerifications).toBe(0);
  });

  it('turns a real asset write failure into admission pressure and clears it only after a healthy disk probe', async () => {
    const lifecycle = new RecordingLifecycle();
    const store = new SnapshotStore({ assetBytes: 0, queuedJobs: 0, retryingJobs: 0 });
    const storage = new StorageProbe({ availableBytes: 150, writable: true });
    let writeVerifications = 0;
    const controller = createCaptureAdmissionController({
      backpressure,
      lifecycle,
      storage: {
        minAvailableBytes: 100,
        probe: storage.probe,
        resumeAvailableBytes: 200,
        verifyWrite: async () => {
          writeVerifications += 1;
        },
      },
      store,
      workspaceId: 'workspace_1',
    });

    await expect(controller.reportStorageWriteFailure()).resolves.toEqual({
      active: true,
      reasons: ['asset_write_failed'],
    });
    await controller.reconcile();
    storage.snapshot = { availableBytes: 200, writable: true };
    await expect(controller.reconcile()).resolves.toEqual({ active: false, reasons: [] });

    expect(lifecycle.storagePauseCalls).toEqual([true, false]);
    expect(writeVerifications).toBe(1);
  });

  it('does not clear an intake storage failure from two healthy reads until write verification succeeds', async () => {
    const lifecycle = new RecordingLifecycle();
    const store = new SnapshotStore({ assetBytes: 0, queuedJobs: 0, retryingJobs: 0 });
    let storageProbes = 0;
    let assetWriteVerifications = 0;
    let operationalWriteVerifications = 0;
    store.verifyOperationalWrite = async () => {
      operationalWriteVerifications += 1;
      throw new Error('operational write still failing');
    };
    const controller = createCaptureAdmissionController({
      backpressure,
      lifecycle,
      storage: {
        minAvailableBytes: 100,
        probe: async () => {
          storageProbes += 1;
          return { availableBytes: 200, writable: true };
        },
        resumeAvailableBytes: 200,
        verifyWrite: async () => {
          assetWriteVerifications += 1;
        },
      },
      store,
      workspaceId: 'workspace_1',
    });

    await expect(controller.reportStorageFailure()).resolves.toEqual({
      active: true,
      reasons: ['storage_state_unavailable'],
    });
    await expect(controller.reconcile()).resolves.toEqual({
      active: true,
      reasons: ['storage_state_unavailable'],
    });
    await expect(controller.reconcile()).resolves.toEqual({
      active: true,
      reasons: ['storage_state_unavailable'],
    });
    expect(store.reads).toBe(2);
    expect(storageProbes).toBe(2);
    expect(operationalWriteVerifications).toBe(2);
    expect(assetWriteVerifications).toBe(0);
  });

  it('does not let a stale write verification clear a newer write failure', async () => {
    const lifecycle = new RecordingLifecycle();
    const store = new SnapshotStore({ assetBytes: 0, queuedJobs: 0, retryingJobs: 0 });
    const deferredVerification = Promise.withResolvers<void>();
    let verifyCalls = 0;
    const controller = createCaptureAdmissionController({
      backpressure,
      lifecycle,
      storage: {
        minAvailableBytes: 100,
        probe: async () => ({ availableBytes: 200, writable: true }),
        resumeAvailableBytes: 200,
        verifyWrite: () => {
          verifyCalls += 1;
          return deferredVerification.promise;
        },
      },
      store,
      workspaceId: 'workspace_1',
    });

    await controller.reportStorageWriteFailure();
    const reconciliation = controller.reconcile();
    while (verifyCalls === 0) {
      await Promise.resolve();
    }
    await controller.reportStorageWriteFailure();
    deferredVerification.resolve();

    await expect(reconciliation).resolves.toEqual({
      active: true,
      reasons: ['asset_write_failed'],
    });
  });

  it('does not let a stale write verification satisfy a newer intake storage failure', async () => {
    const lifecycle = new RecordingLifecycle();
    const store = new SnapshotStore({ assetBytes: 0, queuedJobs: 0, retryingJobs: 0 });
    const staleVerification = Promise.withResolvers<void>();
    let verifyCalls = 0;
    store.verifyOperationalWrite = () => {
      verifyCalls += 1;
      if (verifyCalls === 1) {
        return staleVerification.promise;
      }
      return Promise.reject(new Error('new generation still cannot write'));
    };
    const controller = createCaptureAdmissionController({
      backpressure,
      lifecycle,
      storage: {
        minAvailableBytes: 100,
        probe: async () => ({ availableBytes: 200, writable: true }),
        resumeAvailableBytes: 200,
        verifyWrite: async () => undefined,
      },
      store,
      workspaceId: 'workspace_1',
    });

    await controller.reportStorageFailure();
    const staleReconciliation = controller.reconcile();
    while (verifyCalls === 0) {
      await Promise.resolve();
    }
    await controller.reportStorageFailure();
    staleVerification.resolve();
    await staleReconciliation;

    await controller.reconcile();
    await expect(controller.reconcile()).resolves.toEqual({
      active: true,
      reasons: ['storage_state_unavailable'],
    });
    expect(verifyCalls).toBe(3);
  });

  it('coalesces overlapping storage probes into one reconciliation', async () => {
    const lifecycle = new RecordingLifecycle();
    const store = new SnapshotStore({ assetBytes: 0, queuedJobs: 0, retryingJobs: 0 });
    const deferredProbe = Promise.withResolvers<{ availableBytes: number; writable: boolean }>();
    let probeCalls = 0;
    const controller = createCaptureAdmissionController({
      backpressure,
      lifecycle,
      storage: {
        minAvailableBytes: 100,
        probe: () => {
          probeCalls += 1;
          return deferredProbe.promise;
        },
        resumeAvailableBytes: 200,
        verifyWrite: async () => undefined,
      },
      store,
      workspaceId: 'workspace_1',
    });

    const first = controller.reconcile();
    const overlapping = controller.reconcile();
    expect(overlapping).toBe(first);
    deferredProbe.resolve({ availableBytes: 200, writable: true });

    await expect(first).resolves.toEqual({ active: false, reasons: [] });
    expect(probeCalls).toBe(1);
  });

  it('does not let a disk probe started before a write failure clear that newer failure', async () => {
    const lifecycle = new RecordingLifecycle();
    const store = new SnapshotStore({ assetBytes: 0, queuedJobs: 0, retryingJobs: 0 });
    const deferredProbe = Promise.withResolvers<{ availableBytes: number; writable: boolean }>();
    const controller = createCaptureAdmissionController({
      backpressure,
      lifecycle,
      storage: {
        minAvailableBytes: 100,
        probe: () => deferredProbe.promise,
        resumeAvailableBytes: 200,
        verifyWrite: async () => undefined,
      },
      store,
      workspaceId: 'workspace_1',
    });

    const reconciliation = controller.reconcile();
    await controller.reportStorageWriteFailure();
    deferredProbe.resolve({ availableBytes: 200, writable: true });

    await expect(reconciliation).resolves.toEqual({
      active: true,
      reasons: ['asset_write_failed'],
    });
  });

  it('requires two healthy operational snapshots and a successful write verification before clearing an intake storage failure', async () => {
    const lifecycle = new RecordingLifecycle();
    const store = new SnapshotStore({ assetBytes: 0, queuedJobs: 0, retryingJobs: 0 });
    const storage = new StorageProbe({ availableBytes: 200, writable: true });
    let assetWriteVerifications = 0;
    let operationalWriteVerifications = 0;
    store.verifyOperationalWrite = async () => {
      operationalWriteVerifications += 1;
    };
    const controller = createCaptureAdmissionController({
      backpressure,
      lifecycle,
      storage: {
        minAvailableBytes: 100,
        probe: storage.probe,
        resumeAvailableBytes: 200,
        verifyWrite: async () => {
          assetWriteVerifications += 1;
        },
      },
      store,
      workspaceId: 'workspace_1',
    });

    await expect(controller.reportStorageFailure()).resolves.toEqual({
      active: true,
      reasons: ['storage_state_unavailable'],
    });
    await expect(controller.reconcile()).resolves.toEqual({
      active: true,
      reasons: ['storage_state_unavailable'],
    });
    await expect(controller.reconcile()).resolves.toEqual({ active: false, reasons: [] });

    expect(lifecycle.storagePauseCalls).toEqual([true, false]);
    expect(operationalWriteVerifications).toBe(1);
    expect(assetWriteVerifications).toBe(0);
  });

  it('fails only the disk admission input closed when the physical probe is unavailable', async () => {
    const lifecycle = new RecordingLifecycle();
    const store = new SnapshotStore({ assetBytes: 0, queuedJobs: 0, retryingJobs: 0 });
    const controller = createCaptureAdmissionController({
      backpressure,
      lifecycle,
      storage: {
        minAvailableBytes: 100,
        probe: async () => {
          throw new Error('statfs unavailable');
        },
        resumeAvailableBytes: 200,
        verifyWrite: async () => undefined,
      },
      store,
      workspaceId: 'workspace_1',
    });

    await expect(controller.reconcile()).resolves.toEqual({
      active: true,
      reasons: ['storage_state_unavailable'],
    });
    expect(lifecycle.automaticPauseCalls).toEqual([]);
    expect(lifecycle.storagePauseCalls).toEqual([true]);
  });

  it('fails closed when local queue state cannot be read', async () => {
    const lifecycle = new RecordingLifecycle();
    const controller = createCaptureAdmissionController({
      backpressure,
      lifecycle,
      store: {
        async getBackpressureSnapshot() {
          throw new Error('SQLite unavailable');
        },
        async verifyOperationalWrite() {},
      },
      workspaceId: 'workspace_1',
    });

    await expect(controller.reconcile()).resolves.toEqual({
      active: true,
      reasons: ['queue_state_unavailable'],
    });
    expect(lifecycle.automaticPauseCalls).toEqual([true]);
  });

  it('starts with an immediate reconciliation and stops its timer cleanly', async () => {
    const lifecycle = new RecordingLifecycle();
    const store = new SnapshotStore({ assetBytes: 0, queuedJobs: 0, retryingJobs: 0 });
    const timers = new FakeIntervals();
    const controller = createCaptureAdmissionController({
      backpressure,
      clearIntervalFn: timers.clear,
      intervalMs: 1000,
      lifecycle,
      setIntervalFn: timers.set,
      store,
      workspaceId: 'workspace_1',
    });

    await controller.start();
    timers.fire();
    await flush();
    controller.stop();

    expect(store.reads).toBe(2);
    expect(timers.delays).toEqual([1000]);
    expect(timers.cleared).toEqual([1]);
  });

  it('coalesces overlapping interval reconciliations into one signal sample', async () => {
    const lifecycle = new RecordingLifecycle();
    const deferredSnapshot = Promise.withResolvers<OperationalStoreSnapshot>();
    let reads = 0;
    const controller = createCaptureAdmissionController({
      backpressure,
      lifecycle,
      store: {
        getBackpressureSnapshot() {
          reads += 1;
          return deferredSnapshot.promise;
        },
        async verifyOperationalWrite() {},
      },
      workspaceId: 'workspace_1',
    });

    const first = controller.reconcile();
    const overlapping = controller.reconcile();
    deferredSnapshot.resolve({ assetBytes: 0, queuedJobs: 0, retryingJobs: 0 });

    expect(overlapping).toBe(first);
    await expect(first).resolves.toEqual({ active: false, reasons: [] });
    expect(reads).toBe(1);
  });
});

class RecordingLifecycle {
  automaticPauseCalls: boolean[] = [];
  storagePauseCalls: boolean[] = [];

  async setAutomaticPause(active: boolean): Promise<void> {
    this.automaticPauseCalls.push(active);
  }

  async setStoragePause(active: boolean): Promise<void> {
    this.storagePauseCalls.push(active);
  }
}

class StorageProbe {
  constructor(public snapshot: { availableBytes: number; writable: boolean }) {}

  probe = async () => this.snapshot;
}

class SnapshotStore {
  reads = 0;

  constructor(public snapshot: OperationalStoreSnapshot) {}

  async getBackpressureSnapshot(_workspaceId: string): Promise<OperationalStoreSnapshot> {
    this.reads += 1;
    return this.snapshot;
  }

  verifyOperationalWrite = async (): Promise<void> => undefined;
}

class FakeIntervals {
  delays: number[] = [];
  cleared: number[] = [];
  private callback: (() => void) | undefined;

  set = (callback: () => void, delayMs: number) => {
    this.callback = callback;
    this.delays.push(delayMs);
    return 1;
  };

  clear = (handle: unknown) => {
    this.cleared.push(handle as number);
  };

  fire() {
    this.callback?.();
  }
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}
