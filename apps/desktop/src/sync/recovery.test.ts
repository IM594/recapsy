import { describe, expect, it } from 'bun:test';
import {
  type AssetCacheRef,
  type OutboxJobCreateInput,
  type StoredOcrResult,
  createMemoryStore,
} from '../storage';
import { recoverInterruptedOutboxJobs } from './recovery';

const now = '2026-07-06T00:00:00.000Z';
const recoveryNow = '2026-07-06T00:10:00.000Z';

describe('desktop startup recovery', () => {
  it('recovers interrupted outbox jobs while preserving terminal and retryable jobs', async () => {
    const store = createMemoryStore();
    await seedJob(store, createJob({ id: 'job_syncing', idempotencyKey: 'idem_syncing' }));
    await store.updateOutboxJobState('job_syncing', {
      now: '2026-07-06T00:01:00.000Z',
      state: 'syncing',
    });
    await seedJob(
      store,
      createJob({ id: 'job_result_pending', idempotencyKey: 'idem_result_pending' }),
    );
    await store.updateOutboxJobState('job_result_pending', {
      now: '2026-07-06T00:02:00.000Z',
      ocrResult: createStoredOcrResult(),
      serverCaptureId: 'capture_result_pending',
      state: 'result_pending',
    });
    await seedJob(
      store,
      createJob({
        id: 'job_retry_wait',
        idempotencyKey: 'idem_retry_wait',
        nextRetryAt: '2026-07-06T00:20:00.000Z',
      }),
    );
    await seedTerminalJobs(store);
    await seedJob(
      store,
      createJob({
        id: 'job_other_workspace',
        idempotencyKey: 'idem_other_workspace',
        workspaceId: 'workspace_2',
      }),
      createAsset({ assetRefId: 'asset_job_other_workspace', workspaceId: 'workspace_2' }),
    );
    await store.updateOutboxJobState('job_other_workspace', {
      now: '2026-07-06T00:04:00.000Z',
      state: 'syncing',
    });

    const summary = await recoverInterruptedOutboxJobs({
      now: recoveryNow,
      store,
      workspaceId: 'workspace_1',
    });

    expect(summary).toEqual({
      reconciledSynced: 0,
      recovered: 2,
      resultSubmitInterrupted: 1,
      scanned: 7,
      syncInterrupted: 1,
      unchangedRetryable: 1,
      unchangedTerminal: 4,
    });
    expect(await store.getOutboxJob('job_syncing')).toMatchObject({
      lastSafeError: {
        code: 'interrupted_during_sync',
        message: 'Outbox sync was interrupted before startup recovery.',
        retryable: true,
      },
      nextRetryAt: recoveryNow,
      state: 'pending',
    });
    expect((await store.getOutboxJob('job_syncing'))?.lockedAt).toBeUndefined();
    expect(await store.getOutboxJob('job_result_pending')).toMatchObject({
      lastSafeError: {
        code: 'interrupted_before_result_submit',
        retryable: true,
      },
      nextRetryAt: recoveryNow,
      ocrResult: {
        sourceAssetHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      },
      serverCaptureId: 'capture_result_pending',
      state: 'pending',
    });
    expect((await store.getOutboxJob('job_result_pending'))?.lockedAt).toBeUndefined();
    expect(await store.getOutboxJob('job_retry_wait')).toMatchObject({
      nextRetryAt: '2026-07-06T00:20:00.000Z',
      state: 'pending',
    });
    expect(await store.getOutboxJob('job_cancelled')).toMatchObject({
      state: 'cancelled',
      terminalReason: 'user_cancelled',
    });
    expect(await store.getOutboxJob('job_other_workspace')).toMatchObject({
      state: 'syncing',
      workspaceId: 'workspace_2',
    });
  });

  it('can recover interrupted jobs across all workspaces explicitly', async () => {
    const store = createMemoryStore();
    await seedJob(
      store,
      createJob({
        id: 'job_workspace_1',
        idempotencyKey: 'idem_workspace_1',
        workspaceId: 'workspace_1',
      }),
    );
    await seedJob(
      store,
      createJob({
        id: 'job_workspace_2',
        idempotencyKey: 'idem_workspace_2',
        workspaceId: 'workspace_2',
      }),
      createAsset({ assetRefId: 'asset_job_workspace_2', workspaceId: 'workspace_2' }),
    );
    await store.updateOutboxJobState('job_workspace_1', {
      now,
      state: 'syncing',
    });
    await store.updateOutboxJobState('job_workspace_2', {
      now,
      state: 'syncing',
    });

    const summary = await recoverInterruptedOutboxJobs({
      now: recoveryNow,
      store,
    });

    expect(summary).toMatchObject({
      recovered: 2,
      scanned: 2,
      syncInterrupted: 2,
    });
    expect(await store.getOutboxJob('job_workspace_1')).toMatchObject({ state: 'pending' });
    expect(await store.getOutboxJob('job_workspace_2')).toMatchObject({ state: 'pending' });
  });

  it('reconciles capture-only interrupted jobs to synced when server OCR already succeeded', async () => {
    const store = createMemoryStore();
    await seedJob(store, createJob({ id: 'job_reconcile', idempotencyKey: 'idem_reconcile' }));
    await store.updateOutboxJobState('job_reconcile', {
      now: '2026-07-06T00:03:00.000Z',
      serverCaptureId: 'capture_reconcile',
      state: 'syncing',
    });
    const calls: string[] = [];

    const summary = await recoverInterruptedOutboxJobs({
      api: {
        async getCapture(workspaceId, captureId) {
          calls.push(`capture:${workspaceId}:${captureId}`);
          return {
            captureId,
            ocrJobId: 'ocr_reconcile',
            ocrStatus: 'succeeded',
          };
        },
      },
      now: recoveryNow,
      store,
      workspaceId: 'workspace_1',
    });

    expect(summary).toMatchObject({
      reconciledSynced: 1,
      recovered: 1,
      scanned: 1,
    });
    expect(calls).toEqual(['capture:workspace_1:capture_reconcile']);
    expect(await store.getOutboxJob('job_reconcile')).toMatchObject({
      serverCaptureId: 'capture_reconcile',
      state: 'synced',
      terminalReason: 'ocr_synced',
    });
  });
});

async function seedTerminalJobs(store: ReturnType<typeof createMemoryStore>): Promise<void> {
  const states = [
    ['job_synced', 'idem_synced', 'synced', 'ocr_synced'],
    ['job_blocked', 'idem_blocked', 'blocked', 'provider_not_configured'],
    ['job_failed', 'idem_failed', 'failed', 'unsupported_format'],
    ['job_cancelled', 'idem_cancelled', 'cancelled', 'user_cancelled'],
  ] as const;

  for (const [id, idempotencyKey, state, reason] of states) {
    await seedJob(store, createJob({ id, idempotencyKey }));
    await store.markOutboxJobTerminal(id, {
      now: '2026-07-06T00:05:00.000Z',
      reason,
      state,
    });
  }
}

async function seedJob(
  store: ReturnType<typeof createMemoryStore>,
  job: OutboxJobCreateInput,
  asset: AssetCacheRef = createAsset({
    assetRefId: `asset_${job.id}`,
    workspaceId: job.workspaceId,
  }),
): Promise<void> {
  await store.upsertAssetCacheRef(asset);
  const created = await store.createOutboxJob({
    ...job,
    assetRefId: asset.assetRefId,
  });
  expect(created.ok).toBe(true);
}

function createJob(overrides: Partial<OutboxJobCreateInput> = {}): OutboxJobCreateInput {
  return {
    assetRefId: 'asset_job_1',
    createdAt: now,
    deviceId: 'device_1',
    id: 'job_1',
    idempotencyKey: 'idem_1',
    payloadHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    workspaceId: 'workspace_1',
    ...overrides,
  };
}

function createStoredOcrResult(overrides: Partial<StoredOcrResult> = {}): StoredOcrResult {
  return {
    durationMs: 1200,
    model: 'test-model',
    providerName: 'test-provider',
    screenText: {
      blocks: [{ kind: 'text', readingOrder: 0, source: 'image_ocr', text: 'hello' }],
      readingOrder: 'top_to_bottom_left_to_right',
      source: 'image_ocr',
    },
    sourceAssetHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    ...overrides,
  };
}

function createAsset(overrides: Partial<AssetCacheRef> = {}): AssetCacheRef {
  return {
    assetRefId: 'asset_job_1',
    availabilityState: 'available',
    cleanupState: 'retained',
    createdAt: now,
    hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    localAccessKey: 'content-addressed/local/asset_job_1',
    mimeType: 'image/png',
    role: 'ocr_input',
    sizeBytes: 2048,
    workspaceId: 'workspace_1',
    ...overrides,
  };
}
