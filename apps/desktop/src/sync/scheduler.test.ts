import { describe, expect, it } from 'bun:test';
import { ServerApiError } from '../server-api/client';
import { createInMemoryOperationalStore } from '../storage';
import type { AssetCacheRef, BackpressureDecision, OutboxJobCreateInput } from '../storage';
import { createSyncQueueSummary, createSyncScheduler } from './scheduler';
import type { SyncServerApi } from './types';

const now = '2026-07-06T00:00:00.000Z';

describe('desktop server sync scheduler', () => {
  it('skips work when the active workspace is missing', async () => {
    const store = createInMemoryOperationalStore();
    await seedPendingCapture(store);
    const scheduler = createScheduler({
      api: createApi(),
      store,
      workspaceId: null,
    });

    const result = await scheduler.runOnce();

    expect(result).toEqual({
      code: 'workspace_required',
      processed: 0,
      status: 'skipped',
    });
    expect(await store.getOutboxJob('job_1')).toMatchObject({ state: 'pending' });
  });

  it('guards against workspace switches during a sync run', async () => {
    const store = createInMemoryOperationalStore();
    await seedPendingCapture(store);
    let activeWorkspace: string | null = 'workspace_1';
    const scheduler = createScheduler({
      api: createApi({
        async ingestCapture() {
          activeWorkspace = 'workspace_2';
          return {
            captureId: 'capture_1',
            inputAssetId: 'asset_server_1',
            nextAction: 'create_temporary_upload',
            timelineEventId: 'timeline_1',
          };
        },
      }),
      getWorkspaceId: async () => activeWorkspace,
      store,
    });

    const result = await scheduler.runOnce();
    const job = await store.getOutboxJob('job_1');

    expect(result).toMatchObject({
      processed: 1,
      status: 'retry_wait',
    });
    expect(job).toMatchObject({
      lastSafeError: {
        code: 'workspace_required',
        retryable: true,
      },
      state: 'pending',
    });
  });

  it('runs ingest, temporary upload, OCR create, and success polling', async () => {
    const store = createInMemoryOperationalStore();
    await seedPendingCapture(store);
    const calls: string[] = [];
    const scheduler = createScheduler({
      api: createApi({
        async createOcrJob(input) {
          calls.push(`ocr:${input.idempotencyKey}`);
          return {
            job: {
              id: 'ocr_job_1',
              status: 'queued',
            },
          };
        },
        async createTemporaryUpload(input) {
          calls.push(`temporary:${input.idempotencyKey}`);
          return {
            temporaryLocationId: 'temporary_location_1',
            uploadId: 'upload_1',
          };
        },
        async ingestCapture(input) {
          calls.push(`ingest:${input.idempotencyKey}`);
          return {
            captureId: 'capture_1',
            inputAssetId: 'asset_server_1',
            nextAction: 'create_temporary_upload',
            timelineEventId: 'timeline_1',
          };
        },
        async pollOcrJob() {
          calls.push('poll');
          return {
            job: {
              id: 'ocr_job_1',
              status: 'succeeded',
            },
          };
        },
        async putTemporaryBytes(input) {
          calls.push(`bytes:${input.bytes.byteLength}`);
          return {
            temporaryLocationId: 'temporary_location_1',
            uploadId: 'upload_1',
            uploadReceipt: 'receipt_1',
          };
        },
      }),
      store,
    });

    const result = await scheduler.runOnce();

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
      status: 'synced',
    });
    expect(calls).toEqual([
      'ingest:idem_1',
      'temporary:idem_1:temporary',
      'bytes:4',
      'ocr:idem_1:ocr',
      'poll',
    ]);
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      serverCaptureId: 'capture_1',
      serverOcrJobId: 'ocr_job_1',
      state: 'synced',
      terminalReason: 'ocr_succeeded',
    });
  });

  it('polls an existing server OCR job after startup recovery without uploading bytes again', async () => {
    const store = createInMemoryOperationalStore();
    await seedPendingCapture(store);
    await store.updateOutboxJobState('job_1', {
      now: '2026-07-06T00:00:01.000Z',
      serverCaptureId: 'capture_existing',
      serverOcrJobId: 'ocr_existing',
      state: 'pending',
    });
    const calls: string[] = [];
    const scheduler = createScheduler({
      api: createApi({
        async createOcrJob() {
          calls.push('ocr');
          throw new Error('createOcrJob must not run for recovered OCR polling jobs');
        },
        async createTemporaryUpload() {
          calls.push('temporary');
          throw new Error('createTemporaryUpload must not run for recovered OCR polling jobs');
        },
        async ingestCapture() {
          calls.push('ingest');
          throw new Error('ingestCapture must not run for recovered OCR polling jobs');
        },
        async pollOcrJob(workspaceId, jobId) {
          calls.push(`poll:${workspaceId}:${jobId}`);
          return {
            job: {
              id: jobId,
              status: 'succeeded',
            },
          };
        },
        async putTemporaryBytes() {
          calls.push('bytes');
          throw new Error('putTemporaryBytes must not run for recovered OCR polling jobs');
        },
      }),
      readAssetBytes: async () => {
        calls.push('read-bytes');
        throw new Error('readAssetBytes must not run for recovered OCR polling jobs');
      },
      store,
    });

    const result = await scheduler.runOnce();

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
      status: 'synced',
    });
    expect(calls).toEqual(['poll:workspace_1:ocr_existing']);
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      serverCaptureId: 'capture_existing',
      serverOcrJobId: 'ocr_existing',
      state: 'synced',
      terminalReason: 'ocr_succeeded',
    });
  });

  it('drains existing pending work even when backpressure is pausing new capture', async () => {
    const store = createInMemoryOperationalStore();
    await seedPendingCapture(store);
    const calls: string[] = [];
    const scheduler = createScheduler({
      api: createApi({
        async ingestCapture(input) {
          calls.push(`ingest:${input.idempotencyKey}`);
          return {
            captureId: 'capture_1',
            nextAction: 'none',
            timelineEventId: 'timeline_1',
          };
        },
      }),
      backpressure: {
        action: 'pause',
        hardLimit: true,
        reasons: ['max_queued_jobs_reached'],
      },
      store,
    });

    const result = await scheduler.runOnce();

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
      status: 'synced',
    });
    expect(calls).toEqual(['ingest:idem_1']);
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      state: 'synced',
      terminalReason: 'metadata_synced',
    });
  });

  it('blocks jobs with a safe local asset reason when the asset ref row is missing', async () => {
    const store = createInMemoryOperationalStore();
    const created = await store.createOutboxJob(createJob());
    expect(created.ok).toBe(true);
    const scheduler = createScheduler({
      api: createApi({
        async ingestCapture() {
          throw new Error('ingestCapture must not run when the asset ref row is missing');
        },
      }),
      store,
    });

    const result = await scheduler.runOnce();

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
      status: 'blocked',
    });
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      lastSafeError: {
        code: 'asset_ref_missing',
        message: 'Local asset reference is missing.',
        retryable: false,
      },
      state: 'blocked',
      terminalReason: 'asset_ref_missing',
    });
  });

  it('fails upload-required server actions when the input asset id is missing', async () => {
    const store = createInMemoryOperationalStore();
    await seedPendingCapture(store);
    const scheduler = createScheduler({
      api: createApi({
        async createTemporaryUpload() {
          throw new Error('createTemporaryUpload must not run without an input asset id');
        },
        async ingestCapture() {
          return {
            captureId: 'capture_1',
            nextAction: 'create_temporary_upload',
            timelineEventId: 'timeline_1',
          };
        },
      }),
      store,
    });

    const result = await scheduler.runOnce();

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
      status: 'failed',
    });
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      lastSafeError: {
        code: 'upload_input_missing',
        message: 'Upload input asset is missing.',
        retryable: false,
      },
      state: 'failed',
      terminalReason: 'upload_input_missing',
    });
  });

  it('blocks local asset byte read failures without retrying upload or OCR creation', async () => {
    const store = createInMemoryOperationalStore();
    await seedPendingCapture(store);
    const calls: string[] = [];
    const scheduler = createScheduler({
      api: createApi({
        async createOcrJob() {
          calls.push('ocr');
          throw new Error('createOcrJob must not run when local bytes are unreadable');
        },
        async createTemporaryUpload(input) {
          calls.push(`temporary:${input.assetId}`);
          return {
            temporaryLocationId: 'temporary_location_1',
            uploadId: 'upload_1',
          };
        },
        async putTemporaryBytes() {
          calls.push('bytes');
          throw new Error('putTemporaryBytes must not run when local bytes are unreadable');
        },
      }),
      readAssetBytes: async () => {
        calls.push('read');
        throw Object.assign(new Error('/Users/alice/private.png permission denied'), {
          code: 'local_asset_unreadable',
          retryable: false,
          safeMessage: 'Local asset is unreadable.',
        });
      },
      store,
    });

    const result = await scheduler.runOnce();

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
      status: 'blocked',
    });
    expect(calls).toEqual(['read']);
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      attempt: 0,
      lastSafeError: {
        code: 'local_asset_unreadable',
        message: 'Local asset is unreadable.',
        retryable: false,
      },
      state: 'blocked',
      terminalReason: 'local_asset_unreadable',
    });
  });

  it('maps provider_not_configured to fail-closed blocked state', async () => {
    const store = createInMemoryOperationalStore();
    await seedPendingCapture(store);
    const scheduler = createScheduler({
      api: createApi({
        async pollOcrJob() {
          return {
            job: {
              error: {
                code: 'provider_not_configured',
                messageSafe: 'Provider is not configured.',
                retryable: false,
              },
              id: 'ocr_job_1',
              status: 'failed',
            },
          };
        },
      }),
      store,
    });

    const result = await scheduler.runOnce();

    expect(result).toMatchObject({
      status: 'blocked',
    });
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      state: 'blocked',
      terminalReason: 'provider_not_configured',
    });
  });

  it('keeps provider_unavailable and offline failures retryable', async () => {
    const providerStore = createInMemoryOperationalStore();
    await seedPendingCapture(providerStore);
    const providerScheduler = createScheduler({
      api: createApi({
        async pollOcrJob() {
          return {
            job: {
              error: {
                code: 'provider_unavailable',
                messageSafe: 'Provider is unavailable.',
                retryable: true,
              },
              id: 'ocr_job_1',
              status: 'failed',
            },
          };
        },
      }),
      store: providerStore,
    });

    const offlineStore = createInMemoryOperationalStore();
    await seedPendingCapture(offlineStore);
    const offlineScheduler = createScheduler({
      api: createApi({
        async ingestCapture() {
          throw Object.assign(new Error('offline'), {
            code: 'offline',
            retryable: true,
            safeMessage: 'Network is offline.',
          });
        },
      }),
      store: offlineStore,
    });

    await providerScheduler.runOnce();
    await offlineScheduler.runOnce();

    expect(await providerStore.getOutboxJob('job_1')).toMatchObject({
      lastSafeError: {
        code: 'provider_unavailable',
        retryable: true,
      },
      state: 'pending',
    });
    expect(await offlineStore.getOutboxJob('job_1')).toMatchObject({
      lastSafeError: {
        code: 'offline',
        retryable: true,
      },
      state: 'pending',
    });
  });

  it('does not revive a locally cancelled job after a late server success', async () => {
    const store = createInMemoryOperationalStore();
    await seedPendingCapture(store);
    const scheduler = createScheduler({
      api: createApi({
        async pollOcrJob() {
          await store.markOutboxJobTerminal('job_1', {
            now: '2026-07-06T00:00:03.000Z',
            reason: 'user_cancelled',
            state: 'cancelled',
          });
          return {
            job: {
              id: 'ocr_job_1',
              status: 'succeeded',
            },
          };
        },
      }),
      store,
    });

    const result = await scheduler.runOnce();

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
      status: 'cancelled',
    });
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      state: 'cancelled',
      terminalReason: 'user_cancelled',
    });
  });

  it('marks local cancel terminal before best-effort server cancel and keeps it terminal offline', async () => {
    const store = createInMemoryOperationalStore();
    await seedPendingCapture(store);
    await store.updateOutboxJobState('job_1', {
      now,
      serverOcrJobId: 'ocr_job_1',
      state: 'ocr_wait',
    });
    const scheduler = createScheduler({
      api: createApi({
        async cancelOcrJob() {
          throw new ServerApiError({
            code: 'offline',
            retryable: true,
            safeMessage: 'Network is offline or unavailable.',
          });
        },
      }),
      store,
    });

    const result = await scheduler.cancel('job_1', 'user_cancelled');
    const claimed = await store.claimNextRetryableOutboxJob({
      maxAttempts: 3,
      now: '2026-07-06T00:02:00.000Z',
      workspaceId: 'workspace_1',
    });

    expect(result).toEqual({ cancelled: true, jobId: 'job_1' });
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      state: 'cancelled',
      terminalReason: 'user_cancelled',
    });
    expect(claimed).toBeNull();
  });

  it('treats block_ocr server next actions as stale and never reads or uploads local bytes', async () => {
    const store = createInMemoryOperationalStore();
    await seedPendingCapture(
      store,
      createJob({
        capture: {
          privacyDecision: {
            action: 'block_ocr',
            decidedAt: now,
            policyVersion: 'policy_desktop_1',
            reasons: ['domain_rule'],
          },
        },
      }),
    );
    const calls: string[] = [];
    const scheduler = createScheduler({
      api: createApi({
        async createOcrJob() {
          calls.push('ocr');
          throw new Error('createOcrJob must not be called for block_ocr');
        },
        async createTemporaryUpload() {
          calls.push('temporary');
          throw new Error('createTemporaryUpload must not be called for block_ocr');
        },
        async ingestCapture() {
          calls.push('ingest');
          return {
            captureId: 'capture_1',
            inputAssetId: 'asset_server_1',
            nextAction: 'create_temporary_upload',
            timelineEventId: 'timeline_1',
          };
        },
        async putTemporaryBytes() {
          calls.push('bytes');
          throw new Error('putTemporaryBytes must not be called for block_ocr');
        },
      }),
      readAssetBytes: async () => {
        calls.push('read-bytes');
        throw new Error('readAssetBytes must not be called for block_ocr');
      },
      store,
    });

    const result = await scheduler.runOnce();

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
      status: 'synced',
    });
    expect(calls).toEqual(['ingest']);
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      state: 'synced',
      terminalReason: 'ocr_blocked_by_local_policy',
    });
  });

  it('treats block_capture outbox jobs as metadata-only and does not create a syncable OCR path', async () => {
    const store = createInMemoryOperationalStore();
    await seedPendingCapture(
      store,
      createJob({
        capture: {
          privacyDecision: {
            action: 'block_capture',
            decidedAt: now,
            policyVersion: 'policy_desktop_1',
            reasons: ['app_rule'],
          },
        },
      }),
    );
    const calls: string[] = [];
    const scheduler = createScheduler({
      api: createApi({
        async createTemporaryUpload() {
          calls.push('temporary');
          throw new Error('createTemporaryUpload must not be called for block_capture');
        },
        async ingestCapture() {
          calls.push('ingest');
          return {
            captureId: 'capture_1',
            inputAssetId: 'asset_server_1',
            nextAction: 'queue_ocr',
            timelineEventId: 'timeline_1',
          };
        },
      }),
      readAssetBytes: async () => {
        calls.push('read-bytes');
        throw new Error('readAssetBytes must not be called for block_capture');
      },
      store,
    });

    const result = await scheduler.runOnce();

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
      status: 'synced',
    });
    expect(calls).toEqual(['ingest']);
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      state: 'synced',
      terminalReason: 'capture_blocked_by_local_policy',
    });
  });

  it('redacts untrusted OCR job safe messages before storing errors or queue summaries', async () => {
    const store = createInMemoryOperationalStore();
    await seedPendingCapture(store);
    const leakedText = 'Patient Magnolia Rivera belongs to Project Blue Meridian oncology plan.';
    const scheduler = createScheduler({
      api: createApi({
        async pollOcrJob() {
          return {
            job: {
              error: {
                code: 'provider_timeout',
                messageSafe: `Bearer auth-token sk-provider-token /Users/alice/private.png file:///Users/alice/capture.png https://api.example.test/v1/ocr?image=secret OCR raw text provider body ${leakedText}`,
                retryable: true,
              },
              id: 'ocr_job_1',
              status: 'failed',
            },
          };
        },
      }),
      store,
    });

    await scheduler.runOnce();
    const job = await store.getOutboxJob('job_1');
    const summary = await createSyncQueueSummary(store, 'workspace_1');
    const serialized = JSON.stringify({ job, summary });

    expect(summary.lastError).toMatchObject({
      code: 'provider_unavailable',
      message: 'OCR provider timed out.',
      details: {
        safeCode: 'provider_timeout',
      },
    });
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('sk-provider-token');
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('file:///Users');
    expect(serialized).not.toContain('image=secret');
    expect(serialized).not.toContain('OCR raw text');
    expect(serialized).not.toContain('provider body');
    expect(serialized).not.toContain('Magnolia Rivera');
    expect(serialized).not.toContain('Project Blue Meridian');
    expect(serialized).not.toContain('oncology plan');
  });

  it('does not persist arbitrary server error messages in sync errors or summaries', async () => {
    const store = createInMemoryOperationalStore();
    await seedPendingCapture(store);
    const leakedText = 'Patient Magnolia Rivera belongs to Project Blue Meridian oncology plan.';
    const scheduler = createScheduler({
      api: createApi({
        async ingestCapture() {
          throw new ServerApiError({
            code: 'provider_unavailable',
            retryable: true,
            safeMessage: leakedText,
            status: 503,
          });
        },
      }),
      store,
    });

    await scheduler.runOnce();
    const job = await store.getOutboxJob('job_1');
    const summary = await createSyncQueueSummary(store, 'workspace_1');
    const serialized = JSON.stringify({ job, summary });

    expect(job?.lastSafeError).toMatchObject({
      code: 'provider_unavailable',
      message: 'Provider is unavailable.',
      retryable: true,
    });
    expect(summary.lastError).toMatchObject({
      code: 'provider_unavailable',
      message: 'Provider is unavailable.',
    });
    expect(serialized).not.toContain('Magnolia Rivera');
    expect(serialized).not.toContain('Project Blue Meridian');
    expect(serialized).not.toContain('oncology plan');
  });

  it('cancels server jobs as terminal and returns safe queue summaries under backpressure', async () => {
    const store = createInMemoryOperationalStore();
    await seedPendingCapture(store);
    const cancelledJobs: string[] = [];
    const scheduler = createScheduler({
      api: createApi({
        async cancelOcrJob(jobId) {
          cancelledJobs.push(jobId);
          return {
            cleanupStatus: 'pending',
            job: {
              id: jobId,
              status: 'cancelled',
            },
          };
        },
      }),
      store,
    });

    await store.updateOutboxJobState('job_1', {
      now,
      serverOcrJobId: 'ocr_job_1',
      state: 'ocr_wait',
    });

    const result = await scheduler.cancel('job_1', 'user_cancelled');
    const summary = await createSyncQueueSummary(store, 'workspace_1', {
      backpressure: {
        action: 'pause',
        hardLimit: true,
        reasons: ['max_queued_jobs_reached'],
      },
    });
    const serialized = JSON.stringify(summary);

    expect(result).toEqual({ cancelled: true, jobId: 'job_1' });
    expect(cancelledJobs).toEqual(['ocr_job_1']);
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      state: 'cancelled',
      terminalReason: 'user_cancelled',
    });
    expect(summary).toMatchObject({
      backpressure: {
        active: true,
        reasons: ['max_queued_jobs_reached'],
      },
      pending: 0,
    });
    expect(serialized).not.toContain('/Users/');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('OCR raw text');
  });

  it('persists serverOcrJobId when poll fails after OCR create succeeds', async () => {
    const store = createInMemoryOperationalStore();
    await seedPendingCapture(store);
    const scheduler = createScheduler({
      api: createApi({
        async pollOcrJob() {
          throw new Error('poll interrupted');
        },
      }),
      store,
    });

    const result = await scheduler.runOnce();
    const job = await store.getOutboxJob('job_1');

    expect(result).toMatchObject({
      processed: 1,
      status: 'retry_wait',
    });
    expect(job).toMatchObject({
      serverCaptureId: 'capture_1',
      serverOcrJobId: 'ocr_job_1',
      state: 'pending',
      lastSafeError: {
        code: 'server_unavailable',
        retryable: true,
      },
    });
  });

  it('reconciles capture-only jobs to synced when server OCR already succeeded', async () => {
    const store = createInMemoryOperationalStore();
    await seedPendingCapture(store);
    await store.updateOutboxJobState('job_1', {
      now: '2026-07-06T00:00:01.000Z',
      serverCaptureId: 'capture_existing',
      state: 'pending',
    });
    const calls: string[] = [];
    const scheduler = createScheduler({
      api: createApi({
        async createOcrJob() {
          calls.push('ocr');
          throw new Error('createOcrJob must not run when server OCR already succeeded');
        },
        async getCapture(workspaceId, captureId) {
          calls.push(`capture:${workspaceId}:${captureId}`);
          return {
            captureId,
            ocrJobId: 'ocr_existing',
            ocrStatus: 'succeeded',
          };
        },
        async ingestCapture() {
          calls.push('ingest');
          throw new Error('ingestCapture must not run during capture reconcile');
        },
      }),
      store,
    });

    const result = await scheduler.runOnce();

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
      status: 'synced',
    });
    expect(calls).toEqual(['capture:workspace_1:capture_existing']);
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      serverCaptureId: 'capture_existing',
      serverOcrJobId: 'ocr_existing',
      state: 'synced',
      terminalReason: 'ocr_succeeded',
    });
  });

  it('maps explanatory safe error codes to IPC summaries without collapsing them to unknown', async () => {
    const cases = [
      ['policy_denied', 'policy_denied', undefined],
      ['quota_exceeded', 'quota_exceeded', undefined],
      ['input_too_large', 'input_too_large', undefined],
      ['unsupported_format', 'unsupported_format', undefined],
      ['provider_rate_limited', 'provider_unavailable', 'provider_rate_limited'],
      ['provider_timeout', 'provider_unavailable', 'provider_timeout'],
    ] as const;

    for (const [safeCode, expectedIpcCode, expectedDetailsCode] of cases) {
      const store = createInMemoryOperationalStore();
      await seedPendingCapture(store);
      await store.recordOutboxSafeError('job_1', {
        code: safeCode,
        maxAttempts: 3,
        message: `${safeCode} safe message`,
        now,
        retryable: false,
      });

      const summary = await createSyncQueueSummary(store, 'workspace_1');

      expect(summary.lastError).toMatchObject({
        code: expectedIpcCode,
        message: expectedSyncMessage(safeCode),
      });
      if (expectedDetailsCode) {
        expect(summary.lastError?.details).toEqual({
          safeCode: expectedDetailsCode,
        });
      }
    }
  });
});

async function seedPendingCapture(
  store: ReturnType<typeof createInMemoryOperationalStore>,
  job: OutboxJobCreateInput = createJob(),
) {
  await store.upsertAssetCacheRef(createAsset());
  const created = await store.createOutboxJob(job);
  expect(created.ok).toBe(true);
}

function createScheduler(input: {
  api: SyncServerApi;
  backpressure?: BackpressureDecision;
  getWorkspaceId?: () => Promise<string | null>;
  readAssetBytes?: (localAccessKey: string) => Promise<Uint8Array>;
  store: ReturnType<typeof createInMemoryOperationalStore>;
  workspaceId?: string | null;
}) {
  return createSyncScheduler({
    api: input.api,
    backpressure: input.backpressure,
    clock: createClock(),
    maxAttempts: 3,
    readAssetBytes: input.readAssetBytes ?? (async () => new Uint8Array([1, 2, 3, 4])),
    retryBackoff: { baseMs: 60_000, factor: 2, jitterRatio: 0, maxMs: 300_000 },
    store: input.store,
    workspace: {
      getActiveWorkspaceId:
        input.getWorkspaceId ??
        (async () =>
          Object.hasOwn(input, 'workspaceId') ? (input.workspaceId ?? null) : 'workspace_1'),
    },
  });
}

function createApi(overrides: Partial<SyncServerApi> = {}): SyncServerApi {
  return {
    async cancelOcrJob(jobId) {
      return {
        cleanupStatus: 'pending',
        job: {
          id: jobId,
          status: 'cancelled',
        },
      };
    },
    async createOcrJob() {
      return {
        job: {
          id: 'ocr_job_1',
          status: 'queued',
        },
      };
    },
    async createTemporaryUpload() {
      return {
        temporaryLocationId: 'temporary_location_1',
        uploadId: 'upload_1',
      };
    },
    async getAxAllowlist() {
      return {
        axTextUploadEnabled: false,
        enabled: false,
        reason: 'ax_text_upload_disabled',
        status: 'disabled',
        workspaceId: 'workspace_1',
      };
    },
    async getCapabilities() {
      return {
        features: {},
        generatedAt: now,
        providers: [],
        workspaceId: 'workspace_1',
      };
    },
    async getCapturePolicies() {
      return {
        axAllowlist: {
          axTextUploadEnabled: false,
          enabled: false,
          reason: 'ax_text_upload_disabled',
          status: 'disabled',
          workspaceId: 'workspace_1',
        },
        capturePolicy: {
          actionCounts: {},
          axTextUploadEnabled: false,
          defaultAction: 'allow',
          expiresAt: now,
          paused: false,
          ttlSeconds: 1800,
          version: 'policy_1',
        },
        generatedAt: now,
        storagePolicy: {
          allowLongTermRemoteOriginal: false,
          allowTemporaryServerRead: true,
          authoritativeOriginalLocation: 'local_device',
          temporaryTtlSeconds: 1800,
        },
        workspaceId: 'workspace_1',
      };
    },
    async getCapture() {
      return {
        captureId: 'capture_1',
        ocrStatus: 'not_requested',
      };
    },
    async ingestCapture() {
      return {
        captureId: 'capture_1',
        inputAssetId: 'asset_server_1',
        nextAction: 'create_temporary_upload',
        timelineEventId: 'timeline_1',
      };
    },
    async pollOcrJob() {
      return {
        job: {
          id: 'ocr_job_1',
          status: 'succeeded',
        },
      };
    },
    async putTemporaryBytes() {
      return {
        temporaryLocationId: 'temporary_location_1',
        uploadId: 'upload_1',
        uploadReceipt: 'receipt_1',
      };
    },
    async querySearch() {
      return {
        incomplete: false,
        items: [],
      };
    },
    async queryTimeline() {
      return {
        incomplete: false,
        items: [],
      };
    },
    ...overrides,
  };
}

function expectedSyncMessage(code: string): string {
  if (code === 'policy_denied') {
    return 'Capture policy denied this request.';
  }

  if (code === 'quota_exceeded') {
    return 'Quota has been exceeded.';
  }

  if (code === 'input_too_large') {
    return 'Input is too large.';
  }

  if (code === 'unsupported_format') {
    return 'Input format is unsupported.';
  }

  if (code === 'provider_rate_limited') {
    return 'Provider is rate limited.';
  }

  if (code === 'provider_timeout') {
    return 'OCR provider timed out.';
  }

  return 'Sync failed.';
}

function createClock() {
  let tick = 0;
  return {
    now: () => `2026-07-06T00:00:0${tick++}.000Z`,
  };
}

function createJob(overrides: Partial<OutboxJobCreateInput> = {}): OutboxJobCreateInput {
  return {
    assetRefId: 'asset_ref_1',
    capture: {
      appName: 'Code',
      captureType: 'screen',
      capturedAt: now,
      observedAt: now,
      privacyDecision: {
        action: 'allow',
        decidedAt: now,
        policyVersion: 'policy_desktop_1',
        reasons: [],
      },
    },
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
    assetRefId: 'asset_ref_1',
    availabilityState: 'available',
    cleanupState: 'retained',
    createdAt: now,
    hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    localAccessKey: 'content-addressed/local/asset_ref_1',
    mimeType: 'image/png',
    role: 'ocr_input',
    sizeBytes: 4,
    workspaceId: 'workspace_1',
    ...overrides,
  };
}
