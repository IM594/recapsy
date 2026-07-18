import { describe, expect, it } from 'bun:test';
import { planLocalRetentionDryRun } from '../retention';
import type { AssetCacheRef, OutboxJob } from '../types';

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
