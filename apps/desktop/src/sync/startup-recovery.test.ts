import { describe, expect, it } from 'bun:test';
import {
  type AssetCacheRef,
  type OperationalStoreRepository,
  type OutboxJobCreateInput,
  createInMemoryOperationalStore,
} from '../storage';
import { recoverInterruptedOutboxJobs } from './startup-recovery';

const now = '2026-07-06T00:00:00.000Z';
const recoveryNow = '2026-07-06T00:10:00.000Z';

describe('desktop startup recovery', () => {
  it('recovers interrupted outbox jobs while preserving terminal and retryable jobs', async () => {
    const store = createInMemoryOperationalStore();
    await seedJob(store, createJob({ id: 'job_uploading', idempotencyKey: 'idem_uploading' }));
    await store.updateOutboxJobState('job_uploading', {
      now: '2026-07-06T00:01:00.000Z',
      state: 'uploading',
    });
    await seedJob(store, createJob({ id: 'job_ocr_poll', idempotencyKey: 'idem_ocr_poll' }));
    await store.updateOutboxJobState('job_ocr_poll', {
      now: '2026-07-06T00:02:00.000Z',
      serverCaptureId: 'capture_ocr_poll',
      serverOcrJobId: 'server_ocr_poll',
      state: 'ocr_wait',
    });
    await seedJob(store, createJob({ id: 'job_ocr_split', idempotencyKey: 'idem_ocr_split' }));
    await store.updateOutboxJobState('job_ocr_split', {
      now: '2026-07-06T00:03:00.000Z',
      serverCaptureId: 'capture_ocr_split',
      state: 'ocr_wait',
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
      state: 'uploading',
    });

    const summary = await recoverInterruptedOutboxJobs({
      now: recoveryNow,
      store,
      workspaceId: 'workspace_1',
    });

    expect(summary).toEqual({
      ocrPendingWithoutServerJob: 1,
      ocrPolling: 1,
      reconciledSynced: 0,
      recovered: 3,
      scanned: 8,
      unchangedRetryable: 1,
      unchangedTerminal: 4,
      uploadPending: 1,
    });
    expect(await store.getOutboxJob('job_uploading')).toMatchObject({
      lastSafeError: {
        code: 'interrupted_during_upload',
        message: 'Outbox upload was interrupted before startup recovery.',
        retryable: true,
      },
      nextRetryAt: recoveryNow,
      state: 'pending',
    });
    expect((await store.getOutboxJob('job_uploading'))?.lockedAt).toBeUndefined();
    expect(await store.getOutboxJob('job_ocr_poll')).toMatchObject({
      lastSafeError: {
        code: 'interrupted_while_waiting_for_ocr',
        retryable: true,
      },
      nextRetryAt: recoveryNow,
      serverCaptureId: 'capture_ocr_poll',
      serverOcrJobId: 'server_ocr_poll',
      state: 'pending',
    });
    expect((await store.getOutboxJob('job_ocr_poll'))?.lockedAt).toBeUndefined();
    expect(await store.getOutboxJob('job_ocr_split')).toMatchObject({
      lastSafeError: {
        code: 'interrupted_without_server_job',
        retryable: true,
      },
      nextRetryAt: recoveryNow,
      serverCaptureId: 'capture_ocr_split',
      state: 'pending',
    });
    expect((await store.getOutboxJob('job_ocr_split'))?.serverOcrJobId).toBeUndefined();
    expect(await store.getOutboxJob('job_retry_wait')).toMatchObject({
      nextRetryAt: '2026-07-06T00:20:00.000Z',
      state: 'pending',
    });
    expect(await store.getOutboxJob('job_cancelled')).toMatchObject({
      state: 'cancelled',
      terminalReason: 'user_cancelled',
    });
    expect(await store.getOutboxJob('job_other_workspace')).toMatchObject({
      state: 'uploading',
      workspaceId: 'workspace_2',
    });
  });

  it('can recover interrupted jobs across all workspaces explicitly', async () => {
    const store = createInMemoryOperationalStore();
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
      state: 'uploading',
    });
    await store.updateOutboxJobState('job_workspace_2', {
      now,
      state: 'uploading',
    });

    const summary = await recoverInterruptedOutboxJobs({
      now: recoveryNow,
      store,
    });

    expect(summary).toMatchObject({
      recovered: 2,
      scanned: 2,
      uploadPending: 2,
    });
    expect(await store.getOutboxJob('job_workspace_1')).toMatchObject({ state: 'pending' });
    expect(await store.getOutboxJob('job_workspace_2')).toMatchObject({ state: 'pending' });
  });

  it('reconciles capture-only interrupted jobs to synced when server OCR already succeeded', async () => {
    const store = createInMemoryOperationalStore();
    await seedJob(store, createJob({ id: 'job_reconcile', idempotencyKey: 'idem_reconcile' }));
    await store.updateOutboxJobState('job_reconcile', {
      now: '2026-07-06T00:03:00.000Z',
      serverCaptureId: 'capture_reconcile',
      state: 'ocr_wait',
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
      ocrPendingWithoutServerJob: 0,
      ocrPolling: 0,
      reconciledSynced: 1,
      recovered: 1,
      scanned: 1,
    });
    expect(calls).toEqual(['capture:workspace_1:capture_reconcile']);
    expect(await store.getOutboxJob('job_reconcile')).toMatchObject({
      serverCaptureId: 'capture_reconcile',
      serverOcrJobId: 'ocr_reconcile',
      state: 'synced',
      terminalReason: 'ocr_succeeded',
    });
  });
});

async function seedTerminalJobs(store: OperationalStoreRepository): Promise<void> {
  const states = [
    ['job_synced', 'idem_synced', 'synced', 'ocr_succeeded'],
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
  store: OperationalStoreRepository,
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
