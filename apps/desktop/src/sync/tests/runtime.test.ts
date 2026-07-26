import { describe, expect, it } from 'bun:test';
import { createMemoryStore } from '../../storage';
import type { OutboxJobCreateInput } from '../../storage';
import type { SyncLoop, SyncLoopOptions } from '../loop';
import { createSyncRuntime } from '../runtime';
import type { SyncQueueStore, SyncRunResult, SyncServerApi } from '../types';

describe('sync runtime worker pool', () => {
  it('starts one worker by default for deterministic local diagnosis', async () => {
    const loops: ControlledLoop[] = [];
    const runtime = createSyncRuntime({
      createLoop(options) {
        const loop = new ControlledLoop(options);
        loops.push(loop);
        return loop;
      },
      createServerApi: () => unusedServerApi,
      now: () => '2026-07-19T00:00:00.000Z',
      resolveServerMaxConcurrentOcr: () => 8,
      store: unusedStore,
      workspaceId: 'workspace-1',
    });

    runtime.start();
    await waitForActiveLoops(loops, 1);

    expect(runtime.getCapacityStatus()).toEqual({
      activeWorkers: 1,
      localMaxWorkers: 1,
      serverMaxConcurrentOcr: 8,
    });

    await runtime.stop();
  });

  it('shrinks real loops on throttle, recovers within policy and local limits, and stops every loop', async () => {
    const loops: ControlledLoop[] = [];
    const runtime = createSyncRuntime({
      createLoop(options) {
        const loop = new ControlledLoop(options);
        loops.push(loop);
        return loop;
      },
      createServerApi: () => unusedServerApi,
      localMaxWorkers: 3,
      now: () => '2026-07-19T00:00:00.000Z',
      resolveServerMaxConcurrentOcr: () => 4,
      store: unusedStore,
      workspaceId: 'workspace-1',
    });

    runtime.start();
    await waitForActiveLoops(loops, 3);

    activeLoop(loops).emit({
      code: 'provider_rate_limited',
      processed: 1,
      status: 'retry_wait',
    });
    await waitForActiveLoops(loops, 1);
    expect(runtime.getCapacityStatus().activeWorkers).toBe(1);

    await emitSuccessfulProviderRuns(loops, 3);
    await waitForActiveLoops(loops, 2);
    await emitSuccessfulProviderRuns(loops, 3);
    await waitForActiveLoops(loops, 3);
    expect(runtime.getCapacityStatus()).toEqual({
      activeWorkers: 3,
      localMaxWorkers: 3,
      serverMaxConcurrentOcr: 4,
    });

    runtime.updateServerMaxConcurrentOcr(1);
    await waitForActiveLoops(loops, 1);
    await emitSuccessfulProviderRuns(loops, 6);
    expect(activeLoops(loops)).toHaveLength(1);

    runtime.updateServerMaxConcurrentOcr(8);
    await emitSuccessfulProviderRuns(loops, 6);
    await waitForActiveLoops(loops, 3);
    await emitSuccessfulProviderRuns(loops, 3);
    expect(activeLoops(loops)).toHaveLength(3);
    expect(runtime.getCapacityStatus().activeWorkers).toBe(3);

    await runtime.stop();

    expect(activeLoops(loops)).toHaveLength(0);
    expect(loops.every((loop) => loop.stopCalls === 1)).toBe(true);
  });

  it('publishes the shared provider gate and exposes explicit resume and terminal recovery', async () => {
    const loops: ControlledLoop[] = [];
    const store = createMemoryStore();
    await store.createOutboxJob(createJob());
    await store.markOutboxJobTerminal('job_1', {
      now: '2026-07-27T00:00:00.000Z',
      reason: 'provider_auth_failed',
      state: 'failed',
    });
    const runtime = createSyncRuntime({
      createLoop(options) {
        const loop = new ControlledLoop(options);
        loops.push(loop);
        return loop;
      },
      createServerApi: () => unusedServerApi,
      now: () => '2026-07-27T00:00:00.000Z',
      store,
      workspaceId: 'workspace_1',
    });

    runtime.start();
    await waitForActiveLoops(loops, 1);
    activeLoop(loops).emit({
      code: 'provider_auth_failed',
      processed: 1,
      status: 'retry_wait',
    });

    expect(runtime.getGateStatus()).toMatchObject({
      reason: 'provider_auth_failed',
      state: 'paused',
    });
    expect(await runtime.requeueTerminalJobs()).toBe(1);
    expect(await store.getOutboxJob('job_1')).toMatchObject({ attempt: 0, state: 'pending' });

    runtime.resumeProviderSync();
    expect(runtime.getGateStatus()).toEqual({ state: 'open' });

    await runtime.stop();
  });
});

class ControlledLoop implements SyncLoop {
  active = false;
  startCalls = 0;
  stopCalls = 0;

  constructor(private readonly options: SyncLoopOptions) {}

  emit(result: SyncRunResult): void {
    if (!this.active) {
      throw new Error('Cannot emit a result from a stopped sync loop.');
    }
    this.options.onResult?.(result);
  }

  start(): void {
    this.active = true;
    this.startCalls += 1;
  }

  async stop(): Promise<void> {
    this.active = false;
    this.stopCalls += 1;
  }
}

function activeLoops(loops: readonly ControlledLoop[]): ControlledLoop[] {
  return loops.filter((loop) => loop.active);
}

function activeLoop(loops: readonly ControlledLoop[]): ControlledLoop {
  const loop = activeLoops(loops)[0];
  if (!loop) {
    throw new Error('Expected an active sync loop.');
  }
  return loop;
}

async function emitSuccessfulProviderRuns(
  loops: readonly ControlledLoop[],
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    activeLoop(loops).emit({ processed: 1, providerOutcome: 'succeeded', status: 'synced' });
    await flushMicrotasks();
  }
}

async function waitForActiveLoops(
  loops: readonly ControlledLoop[],
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (activeLoops(loops).length === expected) {
      return;
    }
    await flushMicrotasks();
  }
  throw new Error(`Expected ${expected} active sync loops, received ${activeLoops(loops).length}.`);
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const unusedServerApi = {} as SyncServerApi;
const unusedStore = {} as SyncQueueStore;

function createJob(): OutboxJobCreateInput {
  const now = '2026-07-27T00:00:00.000Z';
  return {
    assetRefId: 'asset_1',
    capture: {
      appName: 'Code',
      captureType: 'screen',
      capturedAt: now,
      observedAt: now,
      privacyDecision: {
        action: 'allow',
        decidedAt: now,
        policyVersion: 'policy_1',
        reasons: [],
      },
    },
    createdAt: now,
    deviceId: 'device_1',
    id: 'job_1',
    idempotencyKey: 'idem_1',
    payloadHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    workspaceId: 'workspace_1',
  };
}
