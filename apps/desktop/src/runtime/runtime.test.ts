import { describe, expect, it } from 'bun:test';
import { createInMemoryOperationalStore } from '../storage';
import { recoverInterruptedOutboxJobs } from '../sync/startup-recovery';
import { createDesktopRuntime } from './lifecycle-controller';
import type { HelperLifecycle } from './types';

describe('desktop runtime lifecycle', () => {
  it('keeps the runtime harness test double out of production modules', async () => {
    const productionHarnessModule = Bun.file(
      new URL('../harness/runtime-harness.ts', import.meta.url),
    );

    expect(await productionHarnessModule.exists()).toBe(false);
  });

  it('enters running after a successful start', async () => {
    const harness = createRuntimeHarness();

    await harness.runtime.start();

    expect(harness.runtime.getSnapshot()).toMatchObject({
      status: 'running',
      menuBarActive: false,
    });
    expect(harness.helper.calls).toEqual(['start']);
  });

  it('keeps the runtime running in the menu bar when the last window closes', async () => {
    const harness = createRuntimeHarness();
    await harness.runtime.start();

    await harness.runtime.handleLastWindowClosed();

    expect(harness.runtime.getSnapshot()).toMatchObject({
      status: 'running',
      menuBarActive: true,
    });
    expect(harness.helper.calls).toEqual(['start']);
  });

  it('pauses and resumes capture without stopping the runtime', async () => {
    const harness = createRuntimeHarness();
    await harness.runtime.start();

    await harness.runtime.pause();

    expect(harness.runtime.getSnapshot()).toMatchObject({
      status: 'paused',
      menuBarActive: false,
    });

    await harness.runtime.resume();

    expect(harness.runtime.getSnapshot()).toMatchObject({
      status: 'running',
      menuBarActive: false,
    });
    expect(harness.helper.calls).toEqual(['start', 'pauseCapture', 'resumeCapture']);
  });

  it('shuts the helper down and stops the runtime on quit', async () => {
    const harness = createRuntimeHarness();
    await harness.runtime.start();

    await harness.runtime.requestQuit();

    expect(harness.runtime.getSnapshot()).toMatchObject({
      status: 'stopped',
      menuBarActive: false,
    });
    expect(harness.helper.calls).toEqual(['start', 'shutdown']);
  });

  it('runs startup recovery before helper capture starts', async () => {
    const calls: string[] = [];
    const runtime = createDesktopRuntime({
      helper: createRecordingHelper(calls),
      startupRecovery: {
        async recover(): Promise<void> {
          calls.push('recover');
        },
      },
    });

    await runtime.start();

    expect(runtime.getSnapshot()).toMatchObject({
      status: 'running',
      menuBarActive: false,
    });
    expect(calls).toEqual(['recover', 'start']);
  });

  it('runs asset ref reconciliation after startup recovery and before helper capture starts', async () => {
    const calls: string[] = [];
    const runtime = createDesktopRuntime({
      assetReconciliation: {
        async reconcile(): Promise<void> {
          calls.push('reconcile');
        },
      },
      helper: createRecordingHelper(calls),
      startupRecovery: {
        async recover(): Promise<void> {
          calls.push('recover');
        },
      },
    });

    await runtime.start();

    expect(runtime.getSnapshot()).toMatchObject({
      status: 'running',
      menuBarActive: false,
    });
    expect(calls).toEqual(['recover', 'reconcile', 'start']);
  });

  it('can wire interrupted outbox recovery into runtime startup through dependency injection', async () => {
    const store = createInMemoryOperationalStore();
    const calls: string[] = [];
    await store.createOutboxJob({
      assetRefId: 'asset_1',
      createdAt: '2026-07-06T00:00:00.000Z',
      deviceId: 'device_1',
      id: 'job_1',
      idempotencyKey: 'idem_1',
      payloadHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      workspaceId: 'workspace_1',
    });
    await store.updateOutboxJobState('job_1', {
      now: '2026-07-06T00:00:01.000Z',
      state: 'syncing',
    });
    const runtime = createDesktopRuntime({
      helper: createRecordingHelper(calls),
      startupRecovery: {
        async recover(): Promise<void> {
          calls.push('recover');
          await recoverInterruptedOutboxJobs({
            now: '2026-07-06T00:00:02.000Z',
            store,
          });
        },
      },
    });

    await runtime.start();

    expect(calls).toEqual(['recover', 'start']);
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      lastSafeError: {
        code: 'interrupted_during_sync',
      },
      nextRetryAt: '2026-07-06T00:00:02.000Z',
      state: 'pending',
    });
  });

  it('fails closed when startup recovery fails before helper capture starts', async () => {
    const calls: string[] = [];
    const runtime = createDesktopRuntime({
      helper: createRecordingHelper(calls),
      startupRecovery: {
        async recover(): Promise<void> {
          calls.push('recover');
          throw new Error('startup recovery failed');
        },
      },
    });

    await expect(runtime.start()).rejects.toThrow('startup recovery failed');

    expect(runtime.getSnapshot()).toMatchObject({
      status: 'stopped',
      menuBarActive: false,
    });
    expect(calls).toEqual(['recover']);
  });

  it('fails closed when asset ref reconciliation fails before helper capture starts', async () => {
    const calls: string[] = [];
    const runtime = createDesktopRuntime({
      assetReconciliation: {
        async reconcile(): Promise<void> {
          calls.push('reconcile');
          throw new Error('asset ref reconciliation failed');
        },
      },
      helper: createRecordingHelper(calls),
      startupRecovery: {
        async recover(): Promise<void> {
          calls.push('recover');
        },
      },
    });

    await expect(runtime.start()).rejects.toThrow('asset ref reconciliation failed');

    expect(runtime.getSnapshot()).toMatchObject({
      status: 'stopped',
      menuBarActive: false,
    });
    expect(calls).toEqual(['recover', 'reconcile']);
  });

  it('fails closed when helper start fails after operational checks', async () => {
    const calls: string[] = [];
    const runtime = createDesktopRuntime({
      assetReconciliation: {
        async reconcile(): Promise<void> {
          calls.push('reconcile');
        },
      },
      helper: {
        async pauseCapture(): Promise<void> {
          calls.push('pauseCapture');
        },
        async resumeCapture(): Promise<void> {
          calls.push('resumeCapture');
        },
        async shutdown(): Promise<void> {
          calls.push('shutdown');
        },
        async start(): Promise<void> {
          calls.push('start');
          throw new Error('helper launch failed');
        },
      },
      startupRecovery: {
        async recover(): Promise<void> {
          calls.push('recover');
        },
      },
    });

    await expect(runtime.start()).rejects.toThrow('helper launch failed');

    expect(runtime.getSnapshot()).toMatchObject({
      status: 'stopped',
      menuBarActive: false,
      captureHelper: {
        state: 'failed',
        lastSafeError: {
          code: 'helper_start_failed',
        },
      },
    });
    expect(calls).toEqual(['recover', 'reconcile', 'start']);
  });
});

function createRuntimeHarness() {
  const helper = createRecordingHelper([]);

  return {
    helper,
    runtime: createDesktopRuntime({ helper }),
  };
}

function createRecordingHelper(calls: string[]): HelperLifecycle & { readonly calls: string[] } {
  return {
    calls,
    async pauseCapture(): Promise<void> {
      calls.push('pauseCapture');
    },
    async resumeCapture(): Promise<void> {
      calls.push('resumeCapture');
    },
    async shutdown(): Promise<void> {
      calls.push('shutdown');
    },
    async start(): Promise<void> {
      calls.push('start');
    },
  };
}
