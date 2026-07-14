import type { BackpressureDecision, OutboxJob, StoredOcrResult } from '../storage/public';
import {
  classifySyncError,
  isLocalAssetSyncErrorCode,
  isTerminalBlockingSyncErrorCode,
  syncSafeMessage,
  toSyncPresentationError,
} from './errors';
import { computeRetryBackoffDelayMs } from './retry';
import { OcrResultInvalidError, mapOcrScreenText } from './screen-text';
import type {
  SyncCancelResult,
  SyncQueueStore,
  SyncQueueSummary,
  SyncRunResult,
  SyncSchedulerOptions,
} from './types';

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
          lastError: toSyncPresentationError(lastSafeError),
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

    let screenText: ReturnType<typeof mapOcrScreenText>;
    try {
      screenText = mapOcrScreenText(ocrResponse);
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
  const classified = classifySyncError(error);
  if (isTerminalBlockingSyncErrorCode(classified.code)) {
    await markJobTerminalWithSafeError(options, job, 'blocked', {
      code: classified.code,
      retryable: false,
    });
    return { jobId: job.id, processed: 1, status: 'blocked' };
  }

  if (isLocalAssetSyncErrorCode(classified.code)) {
    await markJobTerminalWithSafeError(options, job, 'blocked', {
      code: classified.code,
      retryable: false,
    });
    return {
      code: undefined,
      jobId: job.id,
      processed: 1,
      status: 'blocked',
    };
  }

  await recordSafeError(options, job, classified);
  return {
    code: classified.code === 'offline' ? 'offline' : undefined,
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
