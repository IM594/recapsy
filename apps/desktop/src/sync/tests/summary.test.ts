import { describe, expect, it } from 'bun:test';
import type { BackpressureReason, OutboxJob, OutboxJobState } from '../../storage/index';
import { type SyncSummaryStore, createSyncQueueSummary } from '../summary';

const now = '2026-07-06T00:00:00.000Z';

describe('sync queue summary', () => {
  it('reads one workspace-filtered snapshot and derives queue counts in returned order', async () => {
    const reads: Array<{ workspaceId: string }> = [];
    const jobs = [
      outboxJob('pending-idle', 'pending'),
      outboxJob('pending-later', 'pending', {
        lastSafeError: {
          code: 'offline',
          message: 'Network is offline or unavailable.',
          retryable: true,
        },
        nextRetryAt: '2026-07-06T00:05:00.000Z',
      }),
      outboxJob('syncing', 'syncing'),
      outboxJob('result-pending', 'result_pending'),
      outboxJob('blocked', 'blocked'),
      outboxJob('failed', 'failed', {
        lastSafeError: {
          code: 'provider_timeout',
          message: 'This persisted message must not be trusted by the summary.',
          retryable: false,
        },
      }),
      outboxJob('synced', 'synced'),
      outboxJob('cancelled', 'cancelled'),
      outboxJob('pending-earlier', 'pending', {
        nextRetryAt: '2026-07-06T00:01:00.000Z',
      }),
    ];
    const store = {
      async listOutboxJobs(filter: { workspaceId: string }) {
        reads.push(filter);
        return jobs;
      },
    } satisfies SyncSummaryStore;

    const summary = await createSyncQueueSummary(store, 'workspace-1', { now });

    expect(reads).toEqual([{ workspaceId: 'workspace-1' }]);
    expect(summary).toEqual({
      blocked: 1,
      completedPerMinute: 1,
      failed: 1,
      inputPerMinute: 9,
      lastError: {
        code: 'provider_unavailable',
        details: { safeCode: 'provider_timeout' },
        message: 'OCR provider timed out.',
      },
      nextRetryAt: '2026-07-06T00:01:00.000Z',
      oldestActiveAgeSeconds: 0,
      pending: 3,
      processing: 2,
      retrying: 2,
      syncing: 2,
    });
  });

  it('clones backpressure reasons and only marks pause decisions active', async () => {
    const reasons: BackpressureReason[] = ['max_queued_jobs_reached'];
    const store = {
      async listOutboxJobs(_filter: { workspaceId: string }) {
        return [];
      },
    } satisfies SyncSummaryStore;

    const paused = await createSyncQueueSummary(store, 'workspace-1', {
      backpressure: {
        action: 'pause',
        hardLimit: true,
        reasons,
      },
    });
    const allowed = await createSyncQueueSummary(store, 'workspace-1', {
      backpressure: {
        action: 'allow',
        hardLimit: false,
        reasons,
      },
    });
    reasons.push('max_asset_bytes_reached');

    expect(paused.backpressure).toEqual({
      active: true,
      reasons: ['max_queued_jobs_reached'],
    });
    expect(allowed.backpressure).toEqual({
      active: false,
      reasons: ['max_queued_jobs_reached'],
    });
  });

  it('omits optional projections when the workspace queue has no data', async () => {
    const reads: Array<{ workspaceId: string }> = [];
    const store = {
      async listOutboxJobs(filter: { workspaceId: string }) {
        reads.push(filter);
        return [];
      },
    } satisfies SyncSummaryStore;

    const summary = await createSyncQueueSummary(store, 'workspace-empty');

    expect(reads).toEqual([{ workspaceId: 'workspace-empty' }]);
    expect(summary).toEqual({
      blocked: 0,
      completedPerMinute: 0,
      failed: 0,
      inputPerMinute: 0,
      pending: 0,
      processing: 0,
      retrying: 0,
      syncing: 0,
    });
    expect(summary).not.toHaveProperty('backpressure');
    expect(summary).not.toHaveProperty('lastError');
    expect(summary).not.toHaveProperty('nextRetryAt');
  });

  it('derives recent throughput and the age of the oldest unfinished job from the same snapshot', async () => {
    const store = {
      async listOutboxJobs(_filter: { workspaceId: string }) {
        return [
          outboxJob('fresh-pending', 'pending', { createdAt: '2026-07-05T23:59:50.000Z' }),
          outboxJob('old-syncing', 'syncing', { createdAt: '2026-07-05T23:58:00.000Z' }),
          outboxJob('recent-synced', 'synced', { updatedAt: '2026-07-05T23:59:40.000Z' }),
          outboxJob('old-synced', 'synced', {
            createdAt: '2026-07-05T23:58:00.000Z',
            updatedAt: '2026-07-05T23:58:00.000Z',
          }),
        ];
      },
    } satisfies SyncSummaryStore;

    const summary = await createSyncQueueSummary(store, 'workspace-1', { now });

    expect(summary).toMatchObject({
      completedPerMinute: 1,
      inputPerMinute: 2,
      oldestActiveAgeSeconds: 120,
      processing: 1,
    });
  });
});

function outboxJob(
  id: string,
  state: OutboxJobState,
  overrides: Partial<OutboxJob> = {},
): OutboxJob {
  return {
    assetRefId: `asset-${id}`,
    attempt: 0,
    capture: {
      appName: 'Code',
      captureType: 'screen',
      capturedAt: now,
      observedAt: now,
      privacyDecision: {
        action: 'allow',
        decidedAt: now,
        policyVersion: 'policy-1',
        reasons: [],
      },
    },
    createdAt: now,
    deviceId: 'device-1',
    id,
    idempotencyKey: `idempotency-${id}`,
    payloadHash: `sha256:${id}`,
    state,
    updatedAt: now,
    workspaceId: 'workspace-1',
    ...overrides,
  };
}
