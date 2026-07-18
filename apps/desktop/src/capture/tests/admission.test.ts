import { describe, expect, it } from 'bun:test';
import type { BackpressureConfig, OperationalStoreSnapshot } from '../../storage/index';
import { createCaptureAdmissionController } from '../admission';

const backpressure: BackpressureConfig = {
  maxAssetBytes: 600,
  maxQueuedJobs: 6,
  resumeAssetBytes: 200,
  resumeQueuedJobs: 2,
};

describe('capture admission controller', () => {
  it('pauses at a high water mark and resumes only after every low water mark is clear', async () => {
    const lifecycle = new RecordingLifecycle();
    const store = new SnapshotStore({ assetBytes: 100, maxAttempt: 0, queuedJobs: 6 });
    const controller = createCaptureAdmissionController({
      backpressure,
      lifecycle,
      store,
      workspaceId: 'workspace_1',
    });

    await controller.reconcile();
    store.snapshot = { assetBytes: 400, maxAttempt: 0, queuedJobs: 2 };
    await controller.reconcile();
    store.snapshot = { assetBytes: 200, maxAttempt: 0, queuedJobs: 2 };
    await controller.reconcile();

    expect(lifecycle.automaticPauseCalls).toEqual([true, false]);
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
    const store = new SnapshotStore({ assetBytes: 0, maxAttempt: 0, queuedJobs: 0 });
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
});

class RecordingLifecycle {
  automaticPauseCalls: boolean[] = [];

  async setAutomaticPause(active: boolean): Promise<void> {
    this.automaticPauseCalls.push(active);
  }

  async setStoragePause(_active: boolean): Promise<void> {}
}

class SnapshotStore {
  reads = 0;

  constructor(public snapshot: OperationalStoreSnapshot) {}

  async getBackpressureSnapshot(_workspaceId: string): Promise<OperationalStoreSnapshot> {
    this.reads += 1;
    return this.snapshot;
  }
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
