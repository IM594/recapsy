import type { IpcErrorCode, SyncQueueSummaryDto } from '../ipc';
import { ServerApiError } from '../server-api/client';
import type { OcrJobSafeError, OcrJobStatusResult } from '../server-api/types';
import type {
  BackpressureDecision,
  OperationalStoreRepository,
  OutboxJob,
  SafeOperationalError,
} from '../storage';
import type { SyncCancelResult, SyncRunResult, SyncSchedulerOptions } from './types';

const TERMINAL_BLOCKING_OCR_ERRORS = new Set([
  'policy_denied',
  'provider_not_configured',
  'quota_exceeded',
]);
const TERMINAL_FAILED_OCR_ERRORS = new Set([
  'input_too_large',
  'provider_auth_failed',
  'result_invalid',
  'unsupported_format',
]);
const RETRYABLE_OCR_ERRORS = new Set([
  'provider_unavailable',
  'provider_rate_limited',
  'provider_timeout',
]);

export function createSyncScheduler(options: SyncSchedulerOptions) {
  return {
    async cancel(jobId: string, reason: string): Promise<SyncCancelResult> {
      const job = await options.store.getOutboxJob(jobId);

      if (!job) {
        return { cancelled: false, jobId };
      }

      if (job.state === 'cancelled') {
        return { cancelled: true, jobId };
      }

      if (['synced', 'blocked', 'failed'].includes(job.state)) {
        return { cancelled: false, jobId };
      }

      const terminal = await options.store.markOutboxJobTerminal(job.id, {
        now: options.clock.now(),
        reason,
        serverCaptureId: job.serverCaptureId,
        serverOcrJobId: job.serverOcrJobId,
        state: 'cancelled',
      });

      if (!terminal.ok) {
        return { cancelled: false, jobId };
      }

      const activeWorkspaceId = await options.workspace.getActiveWorkspaceId();

      if (job.serverOcrJobId && activeWorkspaceId === job.workspaceId) {
        try {
          await options.api.cancelOcrJob(job.serverOcrJobId, job.workspaceId, reason);
        } catch {
          // Server-side cancellation is best-effort; local terminal state stops retries.
        }
      }

      return { cancelled: true, jobId };
    },
    async runOnce(): Promise<SyncRunResult> {
      const workspaceId = await options.workspace.getActiveWorkspaceId();

      if (!workspaceId) {
        return {
          code: 'workspace_required',
          processed: 0,
          status: 'skipped',
        };
      }

      const job = await options.store.claimNextRetryableOutboxJob({
        maxAttempts: options.maxAttempts,
        now: options.clock.now(),
        workspaceId,
      });

      if (!job) {
        return {
          processed: 0,
          status: 'idle',
        };
      }

      return syncJob(options, job);
    },
  };
}

export async function createSyncQueueSummary(
  store: OperationalStoreRepository,
  workspaceId: string,
  options: {
    backpressure?: BackpressureDecision;
  } = {},
): Promise<SyncQueueSummaryDto> {
  const jobs = await store.listOutboxJobs({ workspaceId });
  const nextRetryAt = jobs
    .map((job) => job.nextRetryAt)
    .filter((value): value is string => typeof value === 'string')
    .sort()[0];
  const lastSafeError = [...jobs].reverse().find((job) => job.lastSafeError)?.lastSafeError;

  return {
    blocked: jobs.filter((job) => job.state === 'blocked').length,
    failed: jobs.filter((job) => job.state === 'failed').length,
    pending: jobs.filter((job) => job.state === 'pending').length,
    retrying: jobs.filter((job) => job.state === 'pending' && job.nextRetryAt).length,
    syncing: jobs.filter((job) => job.state === 'uploading' || job.state === 'ocr_wait').length,
    ...(options.backpressure
      ? {
          backpressure: {
            active: options.backpressure.action === 'pause',
            reasons: [...options.backpressure.reasons],
          },
        }
      : {}),
    ...(lastSafeError
      ? {
          lastError: toIpcError(lastSafeError),
        }
      : {}),
    ...(nextRetryAt ? { nextRetryAt } : {}),
  };
}

async function syncJob(options: SyncSchedulerOptions, job: OutboxJob): Promise<SyncRunResult> {
  let activeJob = job;
  try {
    if (activeJob.serverOcrJobId) {
      return pollExistingOcrJob(options, activeJob);
    }

    if (activeJob.serverCaptureId) {
      const reconciled = await reconcileOutboxJobFromServerCapture(options, activeJob);
      if (reconciled?.status === 'synced') {
        return reconciled;
      }

      const refreshed = await options.store.getOutboxJob(activeJob.id);
      if (refreshed?.serverOcrJobId) {
        return pollExistingOcrJob(options, refreshed);
      }

      if (refreshed) {
        activeJob = refreshed;
      }
    }

    const asset = await options.store.getAssetCacheRef(activeJob.assetRefId);

    if (!asset) {
      await markJobTerminalWithSafeError(options, activeJob, 'blocked', {
        code: 'asset_ref_missing',
        retryable: false,
      });
      return { jobId: activeJob.id, processed: 1, status: 'blocked' };
    }

    if (!(await ensureWorkspaceStillActive(options, activeJob))) {
      return { jobId: activeJob.id, processed: 1, status: 'retry_wait' };
    }

    const capture = await options.api.ingestCapture({
      ...activeJob.capture,
      asset,
      deviceId: activeJob.deviceId,
      idempotencyKey: activeJob.idempotencyKey,
      workspaceId: activeJob.workspaceId,
    });

    await options.store.updateOutboxJobState(activeJob.id, {
      now: options.clock.now(),
      serverCaptureId: capture.captureId,
      state: 'uploading',
    });

    if (activeJob.capture.privacyDecision.action === 'block_capture') {
      await options.store.markOutboxJobTerminal(activeJob.id, {
        now: options.clock.now(),
        reason: 'capture_blocked_by_local_policy',
        serverCaptureId: capture.captureId,
        state: 'synced',
      });
      return { jobId: activeJob.id, processed: 1, status: 'synced' };
    }

    if (activeJob.capture.privacyDecision.action === 'block_ocr') {
      await options.store.markOutboxJobTerminal(activeJob.id, {
        now: options.clock.now(),
        reason: 'ocr_blocked_by_local_policy',
        serverCaptureId: capture.captureId,
        state: 'synced',
      });
      return { jobId: activeJob.id, processed: 1, status: 'synced' };
    }

    if (!(await ensureWorkspaceStillActive(options, activeJob))) {
      return { jobId: activeJob.id, processed: 1, status: 'retry_wait' };
    }

    if (capture.nextAction === 'none') {
      await options.store.markOutboxJobTerminal(activeJob.id, {
        now: options.clock.now(),
        reason: 'metadata_synced',
        serverCaptureId: capture.captureId,
        state: 'synced',
      });
      return { jobId: activeJob.id, processed: 1, status: 'synced' };
    }

    if (!capture.inputAssetId) {
      await markJobTerminalWithSafeError(options, activeJob, 'failed', {
        code: 'upload_input_missing',
        retryable: false,
        serverCaptureId: capture.captureId,
      });
      return { jobId: activeJob.id, processed: 1, status: 'failed' };
    }

    const bytes = await options.readAssetBytes(asset.localAccessKey);

    const upload = await options.api.createTemporaryUpload({
      assetId: capture.inputAssetId,
      contentHash: asset.hash,
      idempotencyKey: `${activeJob.idempotencyKey}:temporary`,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      workspaceId: activeJob.workspaceId,
    });

    await options.api.putTemporaryBytes({
      assetId: capture.inputAssetId,
      bytes,
      mimeType: asset.mimeType,
      workspaceId: activeJob.workspaceId,
    });

    if (!(await ensureWorkspaceStillActive(options, activeJob))) {
      return { jobId: activeJob.id, processed: 1, status: 'retry_wait' };
    }

    const created = await options.api.createOcrJob({
      captureId: capture.captureId,
      idempotencyKey: `${activeJob.idempotencyKey}:ocr`,
      inputAssetId: capture.inputAssetId,
      temporaryLocationId: upload.temporaryLocationId,
      workspaceId: activeJob.workspaceId,
    });

    await options.store.updateOutboxJobState(activeJob.id, {
      now: options.clock.now(),
      serverCaptureId: capture.captureId,
      serverOcrJobId: created.job.id,
      state: 'ocr_wait',
    });

    let polled: OcrJobStatusResult;
    try {
      polled = await options.api.pollOcrJob(activeJob.workspaceId, created.job.id);
    } catch (error) {
      const persisted = await options.store.getOutboxJob(activeJob.id);
      const jobWithPersistedIds = persisted ?? {
        ...activeJob,
        serverCaptureId: capture.captureId,
        serverOcrJobId: created.job.id,
        state: 'ocr_wait' as const,
      };

      if (jobWithPersistedIds.serverOcrJobId) {
        await recordSafeError(options, jobWithPersistedIds, {
          code: 'server_unavailable',
          retryable: true,
        });
        return { jobId: activeJob.id, processed: 1, status: 'retry_wait' };
      }

      return handleSyncError(options, jobWithPersistedIds, error);
    }

    if (await isLocallyCancelled(options.store, activeJob.id)) {
      return { jobId: activeJob.id, processed: 1, status: 'cancelled' };
    }

    if (polled.job.status === 'succeeded') {
      const current = await options.store.getOutboxJob(activeJob.id);
      await options.store.markOutboxJobTerminal(activeJob.id, {
        now: options.clock.now(),
        reason: 'ocr_succeeded',
        serverCaptureId: current?.serverCaptureId ?? capture.captureId,
        serverOcrJobId: current?.serverOcrJobId ?? created.job.id,
        state: 'synced',
      });
      return { jobId: activeJob.id, processed: 1, status: 'synced' };
    }

    if (polled.job.status === 'cancelled') {
      await options.store.markOutboxJobTerminal(activeJob.id, {
        now: options.clock.now(),
        reason: 'server_cancelled',
        serverCaptureId: capture.captureId,
        serverOcrJobId: created.job.id,
        state: 'cancelled',
      });
      return { jobId: activeJob.id, processed: 1, status: 'cancelled' };
    }

    if (polled.job.status === 'failed') {
      return handleOcrFailure(options, activeJob, polled.job.error, {
        captureId: capture.captureId,
        ocrJobId: created.job.id,
      });
    }

    await recordSafeError(options, activeJob, {
      code: 'server_unavailable',
      retryable: true,
    });
    return { jobId: activeJob.id, processed: 1, status: 'retry_wait' };
  } catch (error) {
    return handleSyncError(options, activeJob, error);
  }
}

async function pollExistingOcrJob(
  options: SyncSchedulerOptions,
  job: OutboxJob,
): Promise<SyncRunResult> {
  const serverOcrJobId = job.serverOcrJobId;

  if (!serverOcrJobId) {
    await recordSafeError(options, job, {
      code: 'validation_failed',
      retryable: false,
    });
    return { jobId: job.id, processed: 1, status: 'failed' };
  }

  if (!(await ensureWorkspaceStillActive(options, job))) {
    return { jobId: job.id, processed: 1, status: 'retry_wait' };
  }

  const polled = await options.api.pollOcrJob(job.workspaceId, serverOcrJobId);

  if (await isLocallyCancelled(options.store, job.id)) {
    return { jobId: job.id, processed: 1, status: 'cancelled' };
  }

  if (polled.job.status === 'succeeded') {
    await options.store.markOutboxJobTerminal(job.id, {
      now: options.clock.now(),
      reason: 'ocr_succeeded',
      serverCaptureId: job.serverCaptureId,
      serverOcrJobId,
      state: 'synced',
    });
    return { jobId: job.id, processed: 1, status: 'synced' };
  }

  if (polled.job.status === 'cancelled') {
    await options.store.markOutboxJobTerminal(job.id, {
      now: options.clock.now(),
      reason: 'server_cancelled',
      serverCaptureId: job.serverCaptureId,
      serverOcrJobId,
      state: 'cancelled',
    });
    return { jobId: job.id, processed: 1, status: 'cancelled' };
  }

  if (polled.job.status === 'failed') {
    return handleOcrFailure(options, job, polled.job.error, {
      captureId: job.serverCaptureId,
      ocrJobId: serverOcrJobId,
    });
  }

  await recordSafeError(options, job, {
    code: 'server_unavailable',
    retryable: true,
  });
  return { jobId: job.id, processed: 1, status: 'retry_wait' };
}

async function handleOcrFailure(
  options: SyncSchedulerOptions,
  job: OutboxJob,
  error: OcrJobSafeError | null | undefined,
  ids: { captureId?: string; ocrJobId: string },
): Promise<SyncRunResult> {
  const code = error?.code ?? 'validation_failed';

  if (TERMINAL_BLOCKING_OCR_ERRORS.has(code)) {
    await options.store.markOutboxJobTerminal(job.id, {
      now: options.clock.now(),
      reason: code,
      serverCaptureId: ids.captureId,
      serverOcrJobId: ids.ocrJobId,
      state: 'blocked',
    });
    return { jobId: job.id, processed: 1, status: 'blocked' };
  }

  const retryable =
    !TERMINAL_FAILED_OCR_ERRORS.has(code) &&
    (error?.retryable === true || RETRYABLE_OCR_ERRORS.has(code));
  await recordSafeError(options, job, {
    code,
    retryable,
  });

  return { jobId: job.id, processed: 1, status: retryable ? 'retry_wait' : 'failed' };
}

async function handleSyncError(
  options: SyncSchedulerOptions,
  job: OutboxJob,
  error: unknown,
): Promise<SyncRunResult> {
  if (error instanceof ServerApiError) {
    await recordSafeError(options, job, {
      code: error.code,
      retryable: error.retryable,
    });
    return {
      code: error.code === 'offline' ? 'offline' : undefined,
      jobId: job.id,
      processed: 1,
      status: error.retryable ? 'retry_wait' : 'failed',
    };
  }

  if (isSafeErrorShape(error)) {
    if (isLocalAssetSafeCode(error.code)) {
      await markJobTerminalWithSafeError(options, job, 'blocked', {
        code: error.code,
        retryable: false,
      });
      return {
        code: undefined,
        jobId: job.id,
        processed: 1,
        status: 'blocked',
      };
    }

    await recordSafeError(options, job, {
      code: error.code,
      retryable: error.retryable,
    });
    return {
      code: error.code === 'offline' ? 'offline' : undefined,
      jobId: job.id,
      processed: 1,
      status: error.retryable ? 'retry_wait' : 'failed',
    };
  }

  const classified = classifyUnhandledSyncError(error);
  await recordSafeError(options, job, classified);
  return {
    jobId: job.id,
    processed: 1,
    status: classified.retryable ? 'retry_wait' : 'failed',
  };
}

export async function reconcileOutboxJobFromServerCapture(
  options: {
    api: Pick<SyncSchedulerOptions['api'], 'getCapture'>;
    clock: SyncSchedulerOptions['clock'];
    store: SyncSchedulerOptions['store'];
  },
  job: OutboxJob,
): Promise<SyncRunResult | null> {
  if (!job.serverCaptureId || job.serverOcrJobId) {
    return null;
  }

  if (['synced', 'blocked', 'failed', 'cancelled'].includes(job.state)) {
    return null;
  }

  const capture = await options.api.getCapture(job.workspaceId, job.serverCaptureId);

  if (capture.ocrStatus === 'succeeded') {
    await options.store.markOutboxJobTerminal(job.id, {
      now: options.clock.now(),
      reason: 'ocr_succeeded',
      serverCaptureId: job.serverCaptureId,
      serverOcrJobId: capture.ocrJobId,
      state: 'synced',
    });
    return { jobId: job.id, processed: 1, status: 'synced' };
  }

  if (capture.ocrJobId && (capture.ocrStatus === 'queued' || capture.ocrStatus === 'running')) {
    await options.store.updateOutboxJobState(job.id, {
      now: options.clock.now(),
      serverCaptureId: job.serverCaptureId,
      serverOcrJobId: capture.ocrJobId,
      state: 'ocr_wait',
    });
  }

  return null;
}

function classifyUnhandledSyncError(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof SyntaxError || error instanceof TypeError) {
    return { code: 'validation_failed', retryable: false };
  }

  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) {
      if (isLocalAssetSafeCode(code)) {
        return { code, retryable: false };
      }

      if (isClassifiableSyncErrorCode(code)) {
        return {
          code,
          retryable: isRetryableClassifiableSyncCode(code),
        };
      }
    }

    const message = error.message.toLowerCase();
    if (message.includes('sqlite') || message.includes('database')) {
      return { code: 'server_unavailable', retryable: true };
    }
  }

  return { code: 'validation_failed', retryable: false };
}

function isClassifiableSyncErrorCode(code: string): boolean {
  return [
    'offline',
    'server_unavailable',
    'validation_failed',
    'workspace_required',
    'unknown',
    'result_invalid',
    'temporary_location_missing',
    'cleanup_failed',
  ].includes(code);
}

function isRetryableClassifiableSyncCode(code: string): boolean {
  return code === 'offline' || code === 'server_unavailable' || code === 'unknown';
}

async function markJobTerminalWithSafeError(
  options: SyncSchedulerOptions,
  job: OutboxJob,
  state: 'blocked' | 'failed',
  input: {
    code: string;
    retryable: boolean;
    serverCaptureId?: string;
    serverOcrJobId?: string;
  },
): Promise<void> {
  await options.store.markOutboxJobTerminal(job.id, {
    lastSafeError: {
      code: input.code,
      message: syncSafeMessage(input.code),
      retryable: input.retryable,
    },
    now: options.clock.now(),
    reason: input.code,
    serverCaptureId: input.serverCaptureId ?? job.serverCaptureId,
    serverOcrJobId: input.serverOcrJobId ?? job.serverOcrJobId,
    state,
  });
}

function isSafeErrorShape(
  error: unknown,
): error is { code: string; safeMessage: string; retryable: boolean } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'safeMessage' in error &&
    'retryable' in error &&
    typeof error.code === 'string' &&
    typeof error.safeMessage === 'string' &&
    typeof error.retryable === 'boolean'
  );
}

async function ensureWorkspaceStillActive(
  options: SyncSchedulerOptions,
  job: OutboxJob,
): Promise<boolean> {
  const workspaceId = await options.workspace.getActiveWorkspaceId();

  if (workspaceId === job.workspaceId) {
    return true;
  }

  await recordSafeError(options, job, {
    code: 'workspace_required',
    retryable: true,
  });
  return false;
}

async function recordSafeError(
  options: SyncSchedulerOptions,
  job: OutboxJob,
  error: { code: string; retryable: boolean },
): Promise<void> {
  const retryBase = options.clock.now();
  await options.store.recordOutboxSafeError(job.id, {
    code: error.code,
    maxAttempts: options.maxAttempts,
    message: syncSafeMessage(error.code),
    now: options.clock.now(),
    retryAt: new Date(Date.parse(retryBase) + options.retryDelayMs).toISOString(),
    retryable: error.retryable,
  });
}

async function isLocallyCancelled(
  store: OperationalStoreRepository,
  jobId: string,
): Promise<boolean> {
  const job = await store.getOutboxJob(jobId);
  return job?.state === 'cancelled';
}

function toIpcErrorCode(code: string): IpcErrorCode {
  if (code === 'provider_rate_limited' || code === 'provider_timeout') {
    return 'provider_unavailable';
  }

  if (
    [
      'unauthenticated',
      'workspace_required',
      'offline',
      'server_unavailable',
      'policy_denied',
      'quota_exceeded',
      'provider_not_configured',
      'provider_unavailable',
      'input_too_large',
      'unsupported_format',
      'validation_failed',
      'result_invalid',
      'cancelled',
      'unknown',
    ].includes(code)
  ) {
    return code as IpcErrorCode;
  }

  if (
    code === 'local_asset_missing' ||
    code === 'local_asset_unreadable' ||
    code === 'asset_ref_missing' ||
    code === 'upload_input_missing' ||
    code === 'result_invalid'
  ) {
    return 'validation_failed';
  }

  return 'unknown';
}

function toIpcError(error: SafeOperationalError) {
  const code = toIpcErrorCode(error.code);
  const details =
    code !== error.code && code !== 'unknown'
      ? {
          safeCode: error.code,
        }
      : undefined;

  return {
    code,
    message: syncSafeMessage(error.code),
    ...(details ? { details } : {}),
  };
}

function syncSafeMessage(code: string): string {
  if (code === 'unauthenticated') {
    return 'Authentication is required.';
  }

  if (code === 'workspace_required') {
    return 'Workspace is required.';
  }

  if (code === 'offline') {
    return 'Network is offline or unavailable.';
  }

  if (code === 'server_unavailable') {
    return 'Server is unavailable.';
  }

  if (code === 'policy_denied') {
    return 'Capture policy denied this request.';
  }

  if (code === 'quota_exceeded') {
    return 'Quota has been exceeded.';
  }

  if (code === 'provider_not_configured') {
    return 'Provider is not configured.';
  }

  if (code === 'provider_unavailable') {
    return 'Provider is unavailable.';
  }

  if (code === 'provider_auth_failed') {
    return 'Provider authentication failed.';
  }

  if (code === 'provider_rate_limited') {
    return 'Provider is rate limited.';
  }

  if (code === 'provider_timeout') {
    return 'OCR provider timed out.';
  }

  if (code === 'input_too_large') {
    return 'Input is too large.';
  }

  if (code === 'unsupported_format') {
    return 'Input format is unsupported.';
  }

  if (code === 'validation_failed') {
    return 'Request validation failed.';
  }

  if (code === 'result_invalid') {
    return 'OCR result is invalid.';
  }

  if (code === 'unknown') {
    return 'Sync failed due to an unexpected error.';
  }

  if (code === 'local_asset_missing') {
    return 'Local asset is missing.';
  }

  if (code === 'local_asset_unreadable') {
    return 'Local asset is unreadable.';
  }

  if (code === 'asset_ref_missing') {
    return 'Local asset reference is missing.';
  }

  if (code === 'upload_input_missing') {
    return 'Upload input asset is missing.';
  }

  if (code === 'cancelled') {
    return 'Request was cancelled.';
  }

  return 'Sync failed.';
}

function isLocalAssetSafeCode(code: string): boolean {
  return code === 'local_asset_missing' || code === 'local_asset_unreadable';
}
