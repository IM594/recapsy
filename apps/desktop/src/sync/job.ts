import type {
  AssetCacheRef,
  OperationalStoreResult,
  OutboxJob,
  OutboxJobStateUpdate,
  OutboxSafeErrorInput,
  OutboxTerminalUpdate,
  ReleaseOutboxJobInput,
  ServerCaptureSettlement,
  ServerCaptureSettlementInput,
  StoredOcrResult,
} from '../storage/index';
import {
  classifySyncError,
  isLocalAssetSyncErrorCode,
  isTerminalBlockingSyncErrorCode,
  syncSafeMessage,
} from './errors';
import { createOcrOperationKey } from './ocr-operation';
import { reconcileOutboxJobFromServerCapture } from './reconciliation';
import { computeRetryBackoffDelayMs } from './retry';
import { OcrResultInvalidError, deriveOcrQualityFlags, mapOcrScreenText } from './screen-text';
import type {
  RetryBackoffConfig,
  RetryJitterSource,
  SyncAssetReader,
  SyncClock,
  SyncRunResult,
  SyncServerApi,
  SyncWorkspaceProvider,
} from './types';

export type SyncJobApi = Pick<
  SyncServerApi,
  'getCapture' | 'createCapture' | 'runOcrProxy' | 'submitOcrResult'
>;

export type SyncJobStore = {
  getAssetCacheRef(assetRefId: string): Promise<AssetCacheRef | null>;
  getOutboxJob(id: string): Promise<OutboxJob | null>;
  markOutboxJobTerminal(
    id: string,
    update: OutboxTerminalUpdate,
  ): Promise<OperationalStoreResult<OutboxJob>>;
  settleServerCapture(input: ServerCaptureSettlementInput): Promise<ServerCaptureSettlement>;
  recordOutboxSafeError(
    id: string,
    input: OutboxSafeErrorInput,
  ): Promise<OperationalStoreResult<OutboxJob>>;
  releaseOutboxJob(input: ReleaseOutboxJobInput): Promise<OperationalStoreResult<OutboxJob>>;
  updateOutboxJobState(
    id: string,
    update: OutboxJobStateUpdate,
  ): Promise<OperationalStoreResult<OutboxJob>>;
};

export type SyncJobExecutor = (job: OutboxJob) => Promise<SyncRunResult>;

export type SyncJobExecutorOptions = {
  api: SyncJobApi;
  clock: SyncClock;
  jitterRandom?: RetryJitterSource;
  maxAttempts: number;
  readAssetBytes: SyncAssetReader;
  retryBackoff: RetryBackoffConfig;
  store: SyncJobStore;
  workspace: SyncWorkspaceProvider;
};

export function createSyncJobExecutor(options: SyncJobExecutorOptions): SyncJobExecutor {
  return (job) => executeSyncJob(options, job);
}

async function executeSyncJob(
  options: SyncJobExecutorOptions,
  job: OutboxJob,
): Promise<SyncRunResult> {
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

    // Replay of an already-created capture: if the server already holds a
    // succeeded OCR result, settle locally instead of re-running the proxy.
    if (activeJob.serverCaptureId) {
      const reconciled = await reconcileOutboxJobFromServerCapture(options, activeJob);
      if (reconciled) {
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

    const capture = await options.api.createCapture({
      ...activeJob.capture,
      asset,
      deviceId: activeJob.deviceId,
      idempotencyKey: activeJob.idempotencyKey,
      workspaceId: activeJob.workspaceId,
    });

    await requireOutboxWrite(
      options.store.updateOutboxJobState(activeJob.id, {
        leaseToken: activeJob.leaseToken,
        now: options.clock.now(),
        serverCaptureId: capture.captureId,
        state: 'syncing',
      }),
    );

    if (activeJob.capture.privacyDecision.action === 'block_capture') {
      await requireOutboxWrite(
        options.store.markOutboxJobTerminal(activeJob.id, {
          leaseToken: activeJob.leaseToken,
          now: options.clock.now(),
          reason: 'capture_blocked_by_local_policy',
          serverCaptureId: capture.captureId,
          state: 'synced',
        }),
      );
      return { jobId: activeJob.id, processed: 1, status: 'synced' };
    }

    if (activeJob.capture.privacyDecision.action === 'block_ocr') {
      await requireOutboxWrite(
        options.store.markOutboxJobTerminal(activeJob.id, {
          leaseToken: activeJob.leaseToken,
          now: options.clock.now(),
          reason: 'ocr_blocked_by_local_policy',
          serverCaptureId: capture.captureId,
          state: 'synced',
        }),
      );
      return { jobId: activeJob.id, processed: 1, status: 'synced' };
    }

    if (capture.nextAction === 'none') {
      await requireOutboxWrite(
        options.store.markOutboxJobTerminal(activeJob.id, {
          leaseToken: activeJob.leaseToken,
          now: options.clock.now(),
          reason: 'metadata_synced',
          serverCaptureId: capture.captureId,
          state: 'synced',
        }),
      );
      return { jobId: activeJob.id, processed: 1, status: 'synced' };
    }

    const bytes = await options.readAssetBytes(asset.localAccessKey);

    if (!(await ensureWorkspaceStillActive(options, activeJob))) {
      return { jobId: activeJob.id, processed: 1, status: 'retry_wait' };
    }

    const ocrResponse = await options.api.runOcrProxy({
      bytes,
      mimeType: asset.mimeType,
      operationKey: createOcrOperationKey({
        captureId: activeJob.id,
        mimeType: asset.mimeType,
        sourceAssetHash: asset.hash,
        workspaceId: activeJob.workspaceId,
      }),
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
      qualityFlags: deriveOcrQualityFlags(ocrResponse),
      screenText,
      sourceAssetHash: asset.hash,
      ...(ocrResponse.usage ? { usage: ocrResponse.usage } : {}),
    };

    if (await isLocallyCancelled(options.store, activeJob.id)) {
      return { jobId: activeJob.id, processed: 1, status: 'cancelled' };
    }

    // Persist the transcript before submitting so a submit failure retries only
    // the submit, never another billed proxy call (裁决 1 Option B, §3.2).
    await requireOutboxWrite(
      options.store.updateOutboxJobState(activeJob.id, {
        leaseToken: activeJob.leaseToken,
        now: options.clock.now(),
        ocrResult: storedResult,
        serverCaptureId: capture.captureId,
        state: 'result_pending',
      }),
    );

    const submitted = await submitStoredOcrResult(
      options,
      { ...activeJob, serverCaptureId: capture.captureId },
      storedResult,
    );
    return { ...submitted, providerOutcome: 'succeeded' };
  } catch (error) {
    if (error instanceof OutboxLeaseLostError) {
      return { code: 'lease_lost', jobId: activeJob.id, processed: 0, status: 'skipped' };
    }
    if (isOutboxTerminalConflict(error)) {
      return (await isLocallyCancelled(options.store, activeJob.id))
        ? { jobId: activeJob.id, processed: 1, status: 'cancelled' }
        : { jobId: activeJob.id, processed: 0, status: 'skipped' };
    }
    return handleSyncError(options, activeJob, error);
  }
}

async function submitStoredOcrResult(
  options: SyncJobExecutorOptions,
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
    qualityFlags: storedResult.qualityFlags,
    screenText: storedResult.screenText,
    sourceAssetHash: storedResult.sourceAssetHash,
    workspaceId: job.workspaceId,
    ...(storedResult.usage ? { usage: storedResult.usage } : {}),
  });

  await requireOutboxWrite(
    options.store.markOutboxJobTerminal(job.id, {
      leaseToken: job.leaseToken,
      now: options.clock.now(),
      reason: 'ocr_synced',
      serverCaptureId: job.serverCaptureId,
      state: 'synced',
    }),
  );
  return { jobId: job.id, processed: 1, status: 'synced' };
}

async function handleSyncError(
  options: SyncJobExecutorOptions,
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

  if (
    classified.code === 'provider_auth_failed' ||
    classified.code === 'provider_configuration_invalid'
  ) {
    await requireOutboxWrite(
      options.store.releaseOutboxJob({
        id: job.id,
        lastSafeError: {
          code: classified.code,
          message: syncSafeMessage(classified.code),
          retryable: true,
        },
        leaseToken: job.leaseToken,
        now: options.clock.now(),
      }),
    );
    return {
      code: classified.code,
      jobId: job.id,
      processed: 1,
      status: 'retry_wait',
    };
  }

  const updatedJob = await recordSafeError(options, job, classified);
  return {
    ...(classified.code === 'offline' || classified.code === 'provider_rate_limited'
      ? { code: classified.code }
      : {}),
    jobId: job.id,
    processed: 1,
    ...(classified.code === 'provider_rate_limited' ? { providerOutcome: 'rate_limited' } : {}),
    status: updatedJob.state === 'failed' ? 'failed' : 'retry_wait',
  };
}

async function markJobTerminalWithSafeError(
  options: SyncJobExecutorOptions,
  job: OutboxJob,
  state: 'blocked' | 'failed',
  input: {
    code: string;
    retryable: boolean;
    serverCaptureId?: string;
  },
): Promise<void> {
  await requireOutboxWrite(
    options.store.markOutboxJobTerminal(job.id, {
      leaseToken: job.leaseToken,
      lastSafeError: {
        code: input.code,
        message: syncSafeMessage(input.code),
        retryable: input.retryable,
      },
      now: options.clock.now(),
      reason: input.code,
      serverCaptureId: input.serverCaptureId ?? job.serverCaptureId,
      state,
    }),
  );
}

async function ensureWorkspaceStillActive(
  options: SyncJobExecutorOptions,
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
  options: SyncJobExecutorOptions,
  job: OutboxJob,
  error: { code: string; retryable: boolean },
  maxAttempts = options.maxAttempts,
): Promise<OutboxJob> {
  const retryBase = options.clock.now();
  const delayMs = computeRetryBackoffDelayMs(
    options.retryBackoff,
    job.attempt,
    options.jitterRandom ?? Math.random,
  );
  return await requireOutboxWrite(
    options.store.recordOutboxSafeError(job.id, {
      code: error.code,
      maxAttempts,
      leaseToken: job.leaseToken,
      message: syncSafeMessage(error.code),
      now: options.clock.now(),
      retryAt: new Date(Date.parse(retryBase) + delayMs).toISOString(),
      retryable: error.retryable,
    }),
  );
}

class OutboxLeaseLostError extends Error {
  constructor() {
    super('Outbox job lease is no longer held by this worker.');
    this.name = 'OutboxLeaseLostError';
  }
}

async function requireOutboxWrite(
  result: Promise<OperationalStoreResult<OutboxJob>>,
): Promise<OutboxJob> {
  const settled = await result;
  if (settled.ok) return settled.value;
  if (settled.error.code === 'outbox_lease_lost') {
    throw new OutboxLeaseLostError();
  }
  throw Object.assign(new Error('Outbox state transition was rejected.'), {
    code: settled.error.code,
  });
}

async function isLocallyCancelled(store: SyncJobStore, jobId: string): Promise<boolean> {
  const job = await store.getOutboxJob(jobId);
  return job?.state === 'cancelled';
}

function isOutboxTerminalConflict(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'terminal_state_conflict'
  );
}
