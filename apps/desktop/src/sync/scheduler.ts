import type {
  BackpressureDecision,
  OutboxJob,
  SafeOperationalError,
  StoredOcrResult,
} from '../storage/public';
import { OcrResultInvalidError, deriveScreenTextFromOcrResponse } from './ocr-screen-text-mapping';
import type {
  RetryBackoffConfig,
  RetryJitterSource,
  SyncCancelResult,
  SyncPresentationErrorCode,
  SyncQueueStore,
  SyncQueueSummary,
  SyncRunResult,
  SyncSchedulerOptions,
} from './types';

// Proxy/submit failures the sync flow routes to a terminal `blocked` state
// (policy/authorization denials and unconfigured providers) rather than a
// retryable failure or a generic `failed`. The server-api client already
// computes `retryable`; this set only redirects the non-retryable *policy*
// denials, which are a block rather than a hard failure. See
// `docs/design/OCR_OUTBOX_STATE_MACHINE.md` §3.2.
const TERMINAL_BLOCKING_OCR_ERRORS = new Set([
  'policy_denied',
  'provider_not_configured',
  'quota_exceeded',
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

      // No server-side OCR job exists to cancel in the thin-proxy model, so a
      // cancellation is purely local: the terminal state stops further retries.
      const terminal = await options.store.markOutboxJobTerminal(job.id, {
        now: options.clock.now(),
        reason,
        serverCaptureId: job.serverCaptureId,
        state: 'cancelled',
      });

      if (!terminal.ok) {
        return { cancelled: false, jobId };
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
  store: SyncQueueStore,
  workspaceId: string,
  options: {
    backpressure?: BackpressureDecision;
  } = {},
): Promise<SyncQueueSummary> {
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
    syncing: jobs.filter((job) => job.state === 'syncing' || job.state === 'result_pending').length,
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
    // Crash-recovery fast path: a job that already carries a locally stored OCR
    // result (a `result_pending` row recovered to `pending`) only needs its
    // transcript re-submitted — skip the proxy so the provider is not billed
    // again. See `docs/design/OCR_OUTBOX_STATE_MACHINE.md` §3.2.
    if (activeJob.ocrResult) {
      const submitted = await submitStoredOcrResult(options, activeJob, activeJob.ocrResult);
      return submitted;
    }

    // Replay of an already-ingested capture: if the server already holds a
    // succeeded OCR result, settle locally instead of re-running the proxy.
    if (activeJob.serverCaptureId) {
      const reconciled = await reconcileOutboxJobFromServerCapture(options, activeJob);
      if (reconciled?.status === 'synced') {
        return reconciled;
      }

      const refreshed = await options.store.getOutboxJob(activeJob.id);
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
      state: 'syncing',
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

    if (capture.nextAction === 'none') {
      await options.store.markOutboxJobTerminal(activeJob.id, {
        now: options.clock.now(),
        reason: 'metadata_synced',
        serverCaptureId: capture.captureId,
        state: 'synced',
      });
      return { jobId: activeJob.id, processed: 1, status: 'synced' };
    }

    const bytes = await options.readAssetBytes(asset.localAccessKey);

    if (!(await ensureWorkspaceStillActive(options, activeJob))) {
      return { jobId: activeJob.id, processed: 1, status: 'retry_wait' };
    }

    const ocrResponse = await options.api.runOcrProxy({
      bytes,
      mimeType: asset.mimeType,
      workspaceId: activeJob.workspaceId,
    });

    let screenText: ReturnType<typeof deriveScreenTextFromOcrResponse>;
    try {
      screenText = deriveScreenTextFromOcrResponse(ocrResponse);
    } catch (error) {
      if (error instanceof OcrResultInvalidError) {
        // A deterministic mapping failure: re-mapping the same bytes cannot
        // succeed, so retry means a fresh proxy call (new provider response),
        // counted against the retry budget. See §3.2.
        await recordSafeError(options, activeJob, { code: 'result_invalid', retryable: true });
        return { jobId: activeJob.id, processed: 1, status: 'retry_wait' };
      }

      throw error;
    }

    const storedResult: StoredOcrResult = {
      durationMs: ocrResponse.durationMs,
      model: ocrResponse.model,
      providerName: ocrResponse.providerName,
      screenText,
      sourceAssetHash: asset.hash,
      ...(ocrResponse.usage ? { usage: ocrResponse.usage } : {}),
    };

    // Persist the transcript before submitting so a submit failure retries only
    // the submit, never another billed proxy call (裁决 1 Option B, §3.2).
    await options.store.updateOutboxJobState(activeJob.id, {
      now: options.clock.now(),
      ocrResult: storedResult,
      serverCaptureId: capture.captureId,
      state: 'result_pending',
    });

    const submitted = await submitStoredOcrResult(
      options,
      { ...activeJob, serverCaptureId: capture.captureId },
      storedResult,
    );
    return submitted;
  } catch (error) {
    return handleSyncError(options, activeJob, error);
  }
}

async function submitStoredOcrResult(
  options: SyncSchedulerOptions,
  job: OutboxJob,
  storedResult: StoredOcrResult,
): Promise<SyncRunResult> {
  if (!job.serverCaptureId) {
    await markJobTerminalWithSafeError(options, job, 'failed', {
      code: 'validation_failed',
      retryable: false,
    });
    return { jobId: job.id, processed: 1, status: 'failed' };
  }

  if (!(await ensureWorkspaceStillActive(options, job))) {
    return { jobId: job.id, processed: 1, status: 'retry_wait' };
  }

  if (await isLocallyCancelled(options.store, job.id)) {
    return { jobId: job.id, processed: 1, status: 'cancelled' };
  }

  await options.api.submitOcrResult({
    captureId: job.serverCaptureId,
    durationMs: storedResult.durationMs,
    model: storedResult.model,
    providerName: storedResult.providerName,
    screenText: storedResult.screenText,
    sourceAssetHash: storedResult.sourceAssetHash,
    workspaceId: job.workspaceId,
    ...(storedResult.usage ? { usage: storedResult.usage } : {}),
  });

  await options.store.markOutboxJobTerminal(job.id, {
    now: options.clock.now(),
    reason: 'ocr_synced',
    serverCaptureId: job.serverCaptureId,
    state: 'synced',
  });
  return { jobId: job.id, processed: 1, status: 'synced' };
}

async function handleSyncError(
  options: SyncSchedulerOptions,
  job: OutboxJob,
  error: unknown,
): Promise<SyncRunResult> {
  if (isSafeErrorShape(error)) {
    if (TERMINAL_BLOCKING_OCR_ERRORS.has(error.code)) {
      await markJobTerminalWithSafeError(options, job, 'blocked', {
        code: error.code,
        retryable: false,
      });
      return { jobId: job.id, processed: 1, status: 'blocked' };
    }

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

/**
 * Best-effort reconciliation used on replay and at startup recovery: if the
 * server already reports the capture's OCR as succeeded, settle the local job
 * as `synced` without re-running the proxy (idempotent guard against a crash
 * between a successful submit and the local terminal write). Returns null when
 * there is nothing to settle.
 */
export async function reconcileOutboxJobFromServerCapture(
  options: {
    api: Pick<SyncSchedulerOptions['api'], 'getCapture'>;
    clock: SyncSchedulerOptions['clock'];
    store: SyncSchedulerOptions['store'];
  },
  job: OutboxJob,
): Promise<SyncRunResult | null> {
  if (!job.serverCaptureId) {
    return null;
  }

  if (['synced', 'blocked', 'failed', 'cancelled'].includes(job.state)) {
    return null;
  }

  const capture = await options.api.getCapture(job.workspaceId, job.serverCaptureId);

  if (capture.ocrStatus === 'succeeded') {
    await options.store.markOutboxJobTerminal(job.id, {
      now: options.clock.now(),
      reason: 'ocr_synced',
      serverCaptureId: job.serverCaptureId,
      state: 'synced',
    });
    return { jobId: job.id, processed: 1, status: 'synced' };
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

/**
 * Exponential backoff with symmetric jitter: `min(maxMs, baseMs * factor^attempt)`,
 * then spread by ± `jitterRatio` to de-synchronize concurrent retries across
 * jobs and devices (see `docs/design/OCR_OUTBOX_STATE_MACHINE.md` §4.2). `attempt`
 * is the job's already-consumed retry count — the store increments it when it
 * records the error, so a freshly claimed job on its first failure has
 * `attempt === 0` and waits `baseMs`.
 */
export function computeRetryBackoffDelayMs(
  config: RetryBackoffConfig,
  attempt: number,
  jitterRandom: RetryJitterSource,
): number {
  const exponential = config.baseMs * config.factor ** attempt;
  const capped = Math.min(config.maxMs, exponential);
  const jitterSpan = capped * config.jitterRatio;
  const jitterOffset = jitterSpan * (jitterRandom() * 2 - 1);
  return Math.max(0, Math.round(capped + jitterOffset));
}

async function recordSafeError(
  options: SyncSchedulerOptions,
  job: OutboxJob,
  error: { code: string; retryable: boolean },
): Promise<void> {
  const retryBase = options.clock.now();
  const delayMs = computeRetryBackoffDelayMs(
    options.retryBackoff,
    job.attempt,
    options.jitterRandom ?? Math.random,
  );
  await options.store.recordOutboxSafeError(job.id, {
    code: error.code,
    maxAttempts: options.maxAttempts,
    message: syncSafeMessage(error.code),
    now: options.clock.now(),
    retryAt: new Date(Date.parse(retryBase) + delayMs).toISOString(),
    retryable: error.retryable,
  });
}

async function isLocallyCancelled(store: SyncQueueStore, jobId: string): Promise<boolean> {
  const job = await store.getOutboxJob(jobId);
  return job?.state === 'cancelled';
}

function toPresentationErrorCode(code: string): SyncPresentationErrorCode {
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
    return code as SyncPresentationErrorCode;
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
  const code = toPresentationErrorCode(error.code);
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
