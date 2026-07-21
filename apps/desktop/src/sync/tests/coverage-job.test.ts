import { describe, expect, test } from 'bun:test';
import type { ServerApiCoverageClient } from '../../server/index';
import type {
  CaptureCoverageSegmentRecord,
  DeviceCaptureLivenessRecord,
} from '../../storage/index';
import {
  type CoverageSyncStore,
  createCoverageSyncDriver,
  runCoverageSyncPass,
} from '../coverage-job';

function segment(
  overrides: Partial<CaptureCoverageSegmentRecord> = {},
): CaptureCoverageSegmentRecord {
  return {
    closeReason: 'state_changed',
    coverageState: 'static',
    createdAt: '2026-07-06T00:01:00.000Z',
    deviceId: 'device-1',
    endedAt: '2026-07-06T00:01:00.000Z',
    id: 'seg-1',
    intervalMs: 3000,
    startedAt: '2026-07-06T00:00:00.000Z',
    syncState: 'pending',
    tickCount: 20,
    workspaceId: 'ws-1',
    ...overrides,
  };
}

function liveness(
  overrides: Partial<DeviceCaptureLivenessRecord> = {},
): DeviceCaptureLivenessRecord {
  return {
    deviceId: 'device-1',
    desiredState: 'running',
    lastAliveAt: '2026-07-06T00:01:00.000Z',
    updatedAt: '2026-07-06T00:01:00.000Z',
    workspaceId: 'ws-1',
    ...overrides,
  };
}

type StoreCalls = { markedSynced: string[][] };

function fakeStore(
  pending: CaptureCoverageSegmentRecord[],
  livenessRow: DeviceCaptureLivenessRecord | null,
): { store: CoverageSyncStore; calls: StoreCalls } {
  const calls: StoreCalls = { markedSynced: [] };
  const store: CoverageSyncStore = {
    async getDeviceCaptureLiveness() {
      return livenessRow;
    },
    async listPendingCoverageSegments() {
      return pending;
    },
    async markCoverageSegmentsSynced(ids) {
      calls.markedSynced.push([...ids]);
    },
  };
  return { calls, store };
}

type ApiCalls = { batches: unknown[]; liveness: unknown[] };

function fakeApi(onSubmit?: () => void): { api: ServerApiCoverageClient; calls: ApiCalls } {
  const calls: ApiCalls = { batches: [], liveness: [] };
  const api = {
    async submitCoverageBatch(input: unknown) {
      onSubmit?.();
      calls.batches.push(input);
      return { segments: [] };
    },
    async upsertLiveness(input: unknown) {
      calls.liveness.push(input);
      return { liveness: {} };
    },
  } as unknown as ServerApiCoverageClient;
  return { api, calls };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('coverage sync pass', () => {
  test('ships pending segments as contract input and marks them synced', async () => {
    const { store, calls: storeCalls } = fakeStore([segment()], liveness());
    const { api, calls: apiCalls } = fakeApi();

    const result = await runCoverageSyncPass({
      api,
      deviceId: 'device-1',
      store,
      workspaceId: 'ws-1',
    });

    expect(result.syncedSegments).toBe(1);
    expect(result.livenessUpserted).toBe(true);
    expect(apiCalls.batches).toHaveLength(1);
    // Only the contract input fields are shipped — internal columns are dropped.
    expect(apiCalls.batches[0]).toEqual({
      segments: [
        {
          coverageState: 'static',
          deviceId: 'device-1',
          endedAt: '2026-07-06T00:01:00.000Z',
          intervalMs: 3000,
          startedAt: '2026-07-06T00:00:00.000Z',
          tickCount: 20,
        },
      ],
      workspaceId: 'ws-1',
    });
    expect(storeCalls.markedSynced).toEqual([['seg-1']]);
  });

  test('splits pending segments into batches', async () => {
    const pending = Array.from({ length: 5 }, (_unused, index) =>
      segment({ id: `seg-${index}`, startedAt: `2026-07-06T00:0${index}:00.000Z` }),
    );
    const { store, calls: storeCalls } = fakeStore(pending, null);
    const { api, calls: apiCalls } = fakeApi();

    const result = await runCoverageSyncPass({
      api,
      batchSize: 2,
      deviceId: 'device-1',
      store,
      workspaceId: 'ws-1',
    });

    expect(result.syncedSegments).toBe(5);
    expect(apiCalls.batches).toHaveLength(3);
    expect(storeCalls.markedSynced).toEqual([['seg-0', 'seg-1'], ['seg-2', 'seg-3'], ['seg-4']]);
  });

  test('upserts liveness even with no pending segments', async () => {
    const { store } = fakeStore([], liveness({ desiredState: 'paused' }));
    const { api, calls: apiCalls } = fakeApi();

    const result = await runCoverageSyncPass({
      api,
      deviceId: 'device-1',
      store,
      workspaceId: 'ws-1',
    });

    expect(result.syncedSegments).toBe(0);
    expect(apiCalls.batches).toHaveLength(0);
    expect(apiCalls.liveness).toEqual([
      {
        desiredState: 'paused',
        deviceId: 'device-1',
        lastAliveAt: '2026-07-06T00:01:00.000Z',
        workspaceId: 'ws-1',
      },
    ]);
  });

  test('skips liveness upsert when the device has no liveness row', async () => {
    const { store } = fakeStore([], null);
    const { api, calls: apiCalls } = fakeApi();

    const result = await runCoverageSyncPass({
      api,
      deviceId: 'device-1',
      store,
      workspaceId: 'ws-1',
    });

    expect(result.livenessUpserted).toBe(false);
    expect(apiCalls.liveness).toHaveLength(0);
  });
});

describe('coverage sync driver', () => {
  test('runs a pass on each interval tick and reports errors without stopping', async () => {
    const { store } = fakeStore([segment()], liveness());
    const failure = new Error('network down');
    let attempts = 0;
    const { api } = fakeApi(() => {
      attempts += 1;
      if (attempts === 1) {
        throw failure;
      }
    });

    let registered: (() => void) | undefined;
    const errors: unknown[] = [];
    const results: unknown[] = [];
    let cleared = false;

    const driver = createCoverageSyncDriver({
      api,
      clearIntervalFn: () => {
        cleared = true;
      },
      deviceId: 'device-1',
      onError: (error) => errors.push(error),
      onResult: (result) => results.push(result),
      setIntervalFn: (callback) => {
        registered = callback;
        return 1;
      },
      store,
      workspaceId: 'ws-1',
    });

    driver.start();
    expect(registered).toBeDefined();

    registered?.();
    await flush();
    expect(errors).toEqual([failure]);

    registered?.();
    await flush();
    expect(results).toHaveLength(1);

    driver.stop();
    expect(cleared).toBe(true);
  });
});
