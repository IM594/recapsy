import { describe, expect, it } from 'bun:test';
import type { HelperLifecycle } from '../helper/public';
import { createMemoryStore } from '../storage';
import { recoverInterruptedOutboxJobs } from '../sync/recovery';
import { createCaptureLifecycle } from './lifecycle';

describe('capture lifecycle', () => {
  it('keeps the runtime harness test double out of production modules', async () => {
    const productionHarnessModule = Bun.file(
      new URL('../harness/runtime-harness.ts', import.meta.url),
    );

    expect(await productionHarnessModule.exists()).toBe(false);
  });

  it('enters running after a successful start', async () => {
    const harness = createLifecycleHarness();

    await harness.lifecycle.start();

    expect(harness.lifecycle.getSnapshot()).toMatchObject({
      status: 'running',
      menuBarActive: false,
    });
    expect(harness.helper.calls).toEqual(['start']);
  });

  it('keeps capture running in the menu bar when the last window closes', async () => {
    const harness = createLifecycleHarness();
    await harness.lifecycle.start();

    await harness.lifecycle.handleLastWindowClosed();

    expect(harness.lifecycle.getSnapshot()).toMatchObject({
      status: 'running',
      menuBarActive: true,
    });
    expect(harness.helper.calls).toEqual(['start']);
  });

  it('pauses and resumes capture without stopping the lifecycle', async () => {
    const harness = createLifecycleHarness();
    await harness.lifecycle.start();

    await harness.lifecycle.pause();

    expect(harness.lifecycle.getSnapshot()).toMatchObject({
      status: 'paused',
      menuBarActive: false,
    });

    await harness.lifecycle.resume();

    expect(harness.lifecycle.getSnapshot()).toMatchObject({
      status: 'running',
      menuBarActive: false,
    });
    expect(harness.helper.calls).toEqual(['start', 'pauseCapture', 'resumeCapture']);
  });

  it('shuts the helper down and stops the lifecycle on quit', async () => {
    const harness = createLifecycleHarness();
    await harness.lifecycle.start();

    await harness.lifecycle.requestQuit();

    expect(harness.lifecycle.getSnapshot()).toMatchObject({
      status: 'stopped',
      menuBarActive: false,
    });
    expect(harness.helper.calls).toEqual(['start', 'shutdown']);
  });

  it('runs startup recovery before helper capture starts', async () => {
    const calls: string[] = [];
    const lifecycle = createCaptureLifecycle({
      helper: createRecordingHelper(calls),
      startupRecovery: {
        async recover(): Promise<void> {
          calls.push('recover');
        },
      },
    });

    await lifecycle.start();

    expect(lifecycle.getSnapshot()).toMatchObject({
      status: 'running',
      menuBarActive: false,
    });
    expect(calls).toEqual(['recover', 'start']);
  });

  it('runs asset ref reconciliation after startup recovery and before helper capture starts', async () => {
    const calls: string[] = [];
    const lifecycle = createCaptureLifecycle({
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

    await lifecycle.start();

    expect(lifecycle.getSnapshot()).toMatchObject({
      status: 'running',
      menuBarActive: false,
    });
    expect(calls).toEqual(['recover', 'reconcile', 'start']);
  });

  it('can wire interrupted outbox recovery into lifecycle startup through dependency injection', async () => {
    const store = createMemoryStore();
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
    const lifecycle = createCaptureLifecycle({
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

    await lifecycle.start();

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
    const lifecycle = createCaptureLifecycle({
      helper: createRecordingHelper(calls),
      startupRecovery: {
        async recover(): Promise<void> {
          calls.push('recover');
          throw new Error('startup recovery failed');
        },
      },
    });

    await expect(lifecycle.start()).rejects.toThrow('startup recovery failed');

    expect(lifecycle.getSnapshot()).toMatchObject({
      status: 'stopped',
      menuBarActive: false,
    });
    expect(calls).toEqual(['recover']);
  });

  it('fails closed when asset ref reconciliation fails before helper capture starts', async () => {
    const calls: string[] = [];
    const lifecycle = createCaptureLifecycle({
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

    await expect(lifecycle.start()).rejects.toThrow('asset ref reconciliation failed');

    expect(lifecycle.getSnapshot()).toMatchObject({
      status: 'stopped',
      menuBarActive: false,
    });
    expect(calls).toEqual(['recover', 'reconcile']);
  });

  it('fails closed when helper start fails after operational checks', async () => {
    const calls: string[] = [];
    const lifecycle = createCaptureLifecycle({
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

    await expect(lifecycle.start()).rejects.toThrow('helper launch failed');

    expect(lifecycle.getSnapshot()).toMatchObject({
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

function createLifecycleHarness() {
  const helper = createRecordingHelper([]);

  return {
    helper,
    lifecycle: createCaptureLifecycle({ helper }),
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
