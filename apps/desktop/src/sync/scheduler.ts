import type { IpcErrorCode, SyncQueueSummaryDto } from '../ipc';
import { ServerApiError } from '../server-api/client';
import type { OcrJobSafeError } from '../server-api/types';
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
  try {
    if (job.serverOcrJobId) {
      return pollExistingOcrJob(options, job);
    }

    const asset = await options.store.getAssetCacheRef(job.assetRefId);

    if (!asset) {
      await recordSafeError(options, job, {
        code: 'validation_failed',
        retryable: false,
      });
      return { jobId: job.id, processed: 1, status: 'failed' };
    }

    if (!(await ensureWorkspaceStillActive(options, job))) {
      return { jobId: job.id, processed: 1, status: 'retry_wait' };
    }

    const capture = await options.api.ingestCapture({
      ...job.capture,
      asset,
      deviceId: job.deviceId,
      idempotencyKey: job.idempotencyKey,
      workspaceId: job.workspaceId,
    });

    await options.store.updateOutboxJobState(job.id, {
      now: options.clock.now(),
      serverCaptureId: capture.captureId,
      state: 'uploading',
    });

    if (job.capture.privacyDecision.action === 'block_capture') {
      await options.store.markOutboxJobTerminal(job.id, {
        now: options.clock.now(),
        reason: 'capture_blocked_by_local_policy',
        serverCaptureId: capture.captureId,
        state: 'synced',
      });
      return { jobId: job.id, processed: 1, status: 'synced' };
    }

    if (job.capture.privacyDecision.action === 'block_ocr') {
      await options.store.markOutboxJobTerminal(job.id, {
        now: options.clock.now(),
        reason: 'ocr_blocked_by_local_policy',
        serverCaptureId: capture.captureId,
        state: 'synced',
      });
      return { jobId: job.id, processed: 1, status: 'synced' };
    }

    if (!(await ensureWorkspaceStillActive(options, job))) {
      return { jobId: job.id, processed: 1, status: 'retry_wait' };
    }

    if (capture.nextAction === 'none' || !capture.inputAssetId) {
      await options.store.markOutboxJobTerminal(job.id, {
        now: options.clock.now(),
        reason: 'metadata_synced',
        serverCaptureId: capture.captureId,
        state: 'synced',
      });
      return { jobId: job.id, processed: 1, status: 'synced' };
    }

    const upload = await options.api.createTemporaryUpload({
      assetId: capture.inputAssetId,
      contentHash: asset.hash,
      idempotencyKey: `${job.idempotencyKey}:temporary`,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      workspaceId: job.workspaceId,
    });

    const bytes = await options.readAssetBytes(asset.localAccessKey);
    await options.api.putTemporaryBytes({
      assetId: capture.inputAssetId,
      bytes,
      mimeType: asset.mimeType,
      workspaceId: job.workspaceId,
    });

    if (!(await ensureWorkspaceStillActive(options, job))) {
      return { jobId: job.id, processed: 1, status: 'retry_wait' };
    }

    const created = await options.api.createOcrJob({
      captureId: capture.captureId,
      idempotencyKey: `${job.idempotencyKey}:ocr`,
      inputAssetId: capture.inputAssetId,
      temporaryLocationId: upload.temporaryLocationId,
      workspaceId: job.workspaceId,
    });

    await options.store.updateOutboxJobState(job.id, {
      now: options.clock.now(),
      serverCaptureId: capture.captureId,
      serverOcrJobId: created.job.id,
      state: 'ocr_wait',
    });

    const polled = await options.api.pollOcrJob(job.workspaceId, created.job.id);

    if (await isLocallyCancelled(options.store, job.id)) {
      return { jobId: job.id, processed: 1, status: 'cancelled' };
    }

    if (polled.job.status === 'succeeded') {
      const current = await options.store.getOutboxJob(job.id);
      await options.store.markOutboxJobTerminal(job.id, {
        now: options.clock.now(),
        reason: 'ocr_succeeded',
        serverCaptureId: current?.serverCaptureId ?? capture.captureId,
        serverOcrJobId: current?.serverOcrJobId ?? created.job.id,
        state: 'synced',
      });
      return { jobId: job.id, processed: 1, status: 'synced' };
    }

    if (polled.job.status === 'cancelled') {
      await options.store.markOutboxJobTerminal(job.id, {
        now: options.clock.now(),
        reason: 'server_cancelled',
        serverCaptureId: capture.captureId,
        serverOcrJobId: created.job.id,
        state: 'cancelled',
      });
      return { jobId: job.id, processed: 1, status: 'cancelled' };
    }

    if (polled.job.status === 'failed') {
      return handleOcrFailure(options, job, polled.job.error, {
        captureId: capture.captureId,
        ocrJobId: created.job.id,
      });
    }

    await recordSafeError(options, job, {
      code: 'server_unavailable',
      retryable: true,
    });
    return { jobId: job.id, processed: 1, status: 'retry_wait' };
  } catch (error) {
    return handleSyncError(options, job, error);
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
  const code = error?.code ?? 'unknown';

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

  await recordSafeError(options, job, {
    code: 'unknown',
    retryable: true,
  });
  return { jobId: job.id, processed: 1, status: 'retry_wait' };
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
      'cancelled',
      'unknown',
    ].includes(code)
  ) {
    return code as IpcErrorCode;
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

  if (code === 'cancelled') {
    return 'Request was cancelled.';
  }

  return 'Sync failed.';
}
