import { describe, expect, it } from 'bun:test';
import { createMemoryStore } from '../memory';
import { executeLocalRetention, planLocalRetentionDryRun } from '../retention';
import type { AssetCacheRef, OutboxJob, OutboxJobCreateInput } from '../types';

const now = '2026-07-18T00:00:00.000Z';
const workspaceId = 'workspace_1';

describe('local retention dry run', () => {
  it('only proposes retained, available assets whose every owning job is synced', async () => {
    const result = await planLocalRetentionDryRun({
      now,
      olderThanDays: 30,
      store: {
        async listAssetCacheRefs() {
          return [
            asset('eligible', '2026-06-01T00:00:00.000Z', 100),
            asset('recent', '2026-07-10T00:00:00.000Z', 200),
            asset('pending', '2026-06-01T00:00:00.000Z', 300),
            asset('unreadable', '2026-06-01T00:00:00.000Z', 400, {
              availabilityState: 'unreadable',
            }),
            asset('already-cleaned', '2026-06-01T00:00:00.000Z', 500, { cleanupState: 'cleaned' }),
            asset('unreferenced', '2026-06-01T00:00:00.000Z', 600),
          ];
        },
        async listOutboxJobs() {
          return [
            job('eligible', 'synced'),
            job('recent', 'synced'),
            job('pending', 'pending'),
            job('unreadable', 'synced'),
            job('already-cleaned', 'synced'),
          ];
        },
      },
      workspaceId,
    });

    expect(result).toEqual({
      cutoffAt: '2026-06-18T00:00:00.000Z',
      eligibleAssets: 1,
      evaluatedAssets: 6,
      olderThanDays: 30,
      protectedAssets: 5,
      reclaimableBytes: 100,
    });
  });

  it('does not mutate local assets or queue state', async () => {
    const assetRefs = [asset('eligible', '2026-06-01T00:00:00.000Z', 100)];
    const jobs = [job('eligible', 'synced')];
    await planLocalRetentionDryRun({
      now,
      olderThanDays: 30,
      store: {
        async listAssetCacheRefs() {
          return assetRefs;
        },
        async listOutboxJobs() {
          return jobs;
        },
      },
      workspaceId,
    });

    expect(assetRefs).toEqual([asset('eligible', '2026-06-01T00:00:00.000Z', 100)]);
    expect(jobs).toEqual([job('eligible', 'synced')]);
  });

  it('includes a prior cleanup failure in the next explicit review', async () => {
    const result = await planLocalRetentionDryRun({
      now,
      olderThanDays: 30,
      store: {
        async listAssetCacheRefs() {
          return [
            asset('retryable', '2026-06-01T00:00:00.000Z', 100, {
              cleanupState: 'cleanup_failed',
            }),
          ];
        },
        async listOutboxJobs() {
          return [job('retryable', 'synced')];
        },
      },
      workspaceId,
    });

    expect(result).toMatchObject({ eligibleAssets: 1, protectedAssets: 0, reclaimableBytes: 100 });
  });

  it('records a durable cleanup failure and retries the same eligible asset', async () => {
    const store = createMemoryStore();
    await prepareSyncedAsset(store);
    let attempts = 0;

    const failed = await executeLocalRetention({
      now,
      olderThanDays: 30,
      removeAsset: async () => {
        attempts += 1;
        throw new Error('permission denied for a private path');
      },
      store,
      workspaceId,
    });

    expect(failed).toEqual({
      cleanedAssets: 0,
      failedAssets: 1,
      protectedAssets: 0,
      reclaimedBytes: 0,
      retriedInterruptedAssets: 0,
    });
    expect(await store.getAssetCacheRef('eligible')).toMatchObject({
      cleanupSafeError: {
        code: 'local_asset_cleanup_failed',
        message: 'Local asset cleanup failed.',
        retryable: true,
      },
      cleanupState: 'cleanup_failed',
      cleanupUpdatedAt: now,
    });

    const succeeded = await executeLocalRetention({
      now: '2026-07-18T00:01:00.000Z',
      olderThanDays: 30,
      removeAsset: async (localAccessKey) => {
        attempts += 1;
        expect(localAccessKey).toBe('eligible');
      },
      store,
      workspaceId,
    });

    expect(attempts).toBe(2);
    expect(succeeded).toEqual({
      cleanedAssets: 1,
      failedAssets: 0,
      protectedAssets: 0,
      reclaimedBytes: 100,
      retriedInterruptedAssets: 0,
    });
    expect(await store.getAssetCacheRef('eligible')).toMatchObject({
      availabilityState: 'missing',
      cleanupState: 'cleaned',
      cleanupUpdatedAt: '2026-07-18T00:01:00.000Z',
    });
  });

  it('reclaims an interrupted pending cleanup so a missing file converges to cleaned', async () => {
    const store = createMemoryStore();
    await prepareSyncedAsset(store, { cleanupState: 'cleanup_pending' });
    const removed: string[] = [];

    const result = await executeLocalRetention({
      now,
      olderThanDays: 30,
      removeAsset: async (localAccessKey) => {
        removed.push(localAccessKey);
      },
      store,
      workspaceId,
    });

    expect(removed).toEqual(['eligible']);
    expect(result).toEqual({
      cleanedAssets: 1,
      failedAssets: 0,
      protectedAssets: 0,
      reclaimedBytes: 100,
      retriedInterruptedAssets: 1,
    });
    expect(await store.getAssetCacheRef('eligible')).toMatchObject({
      cleanupState: 'cleaned',
      cleanupUpdatedAt: now,
    });
  });
});

function asset(
  assetRefId: string,
  createdAt: string,
  sizeBytes: number,
  overrides: Partial<AssetCacheRef> = {},
): AssetCacheRef {
  return {
    assetRefId,
    availabilityState: 'available',
    cleanupState: 'retained',
    createdAt,
    hash: `sha256:${assetRefId}`,
    localAccessKey: assetRefId,
    mimeType: 'image/webp',
    role: 'capture_original',
    sizeBytes,
    workspaceId,
    ...overrides,
  };
}

function job(assetRefId: string, state: OutboxJob['state']): OutboxJob {
  return {
    assetRefId,
    attempt: 0,
    capture: {
      appName: 'Recapsy',
      captureType: 'window',
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
    id: `job_${assetRefId}`,
    idempotencyKey: `idem_${assetRefId}`,
    payloadHash: `sha256:${assetRefId}`,
    state,
    updatedAt: now,
    workspaceId,
  };
}

async function prepareSyncedAsset(
  store: ReturnType<typeof createMemoryStore>,
  overrides: Partial<AssetCacheRef> = {},
): Promise<void> {
  const assetRefId = 'eligible';
  await store.upsertAssetCacheRef(asset(assetRefId, '2026-06-01T00:00:00.000Z', 100, overrides));
  const created = await store.createOutboxJob({
    assetRefId,
    createdAt: now,
    deviceId: 'device_1',
    id: 'job_eligible',
    idempotencyKey: 'idem_eligible',
    payloadHash: 'sha256:eligible',
    workspaceId,
  } satisfies OutboxJobCreateInput);
  expect(created.ok).toBe(true);
  const settled = await store.markOutboxJobTerminal('job_eligible', {
    now,
    reason: 'ocr_synced',
    state: 'synced',
  });
  expect(settled.ok).toBe(true);
}
