import type {
  AiOcrResponse,
  AiOcrUsage,
  CaptureNextAction,
  OcrResultSubmitResponse,
  OcrScreenTextResult,
} from '@recapsy/contracts';
import type {
  AssetCacheRef,
  CaptureOutboxPayload,
  ClaimRetryableOutboxJobInput,
  OperationalStoreResult,
  OutboxJob,
  OutboxJobListFilter,
  OutboxJobStateUpdate,
  OutboxSafeErrorInput,
  OutboxTerminalUpdate,
  RecoverInterruptedOutboxJobInput,
} from '../storage/public';

export type SyncCaptureCreateInput = CaptureOutboxPayload & {
  workspaceId: string;
  deviceId: string;
  idempotencyKey: string;
  asset: Pick<AssetCacheRef, 'assetRefId' | 'hash' | 'mimeType' | 'role' | 'sizeBytes'>;
};

export type SyncServerApi = {
  createCapture(input: SyncCaptureCreateInput): Promise<{
    captureId: string;
    timelineEventId: string;
    nextAction: CaptureNextAction;
    inputAssetId?: string;
  }>;
  getCapture(
    workspaceId: string,
    captureId: string,
  ): Promise<{
    captureId: string;
    ocrStatus: 'not_requested' | 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked';
    ocrJobId?: string;
  }>;
  runOcrProxy(input: {
    workspaceId: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<AiOcrResponse>;
  submitOcrResult(input: {
    workspaceId: string;
    captureId: string;
    sourceAssetHash: string;
    screenText: OcrScreenTextResult;
    model: string;
    providerName: string;
    durationMs: number;
    usage?: AiOcrUsage;
  }): Promise<OcrResultSubmitResponse>;
};

export type SyncQueueStore = {
  claimNextRetryableOutboxJob(input: ClaimRetryableOutboxJobInput): Promise<OutboxJob | null>;
  getAssetCacheRef(assetRefId: string): Promise<AssetCacheRef | null>;
  getOutboxJob(id: string): Promise<OutboxJob | null>;
  listOutboxJobs(filter?: OutboxJobListFilter): Promise<OutboxJob[]>;
  markOutboxJobTerminal(
    id: string,
    update: OutboxTerminalUpdate,
  ): Promise<OperationalStoreResult<OutboxJob>>;
  recordOutboxSafeError(
    id: string,
    input: OutboxSafeErrorInput,
  ): Promise<OperationalStoreResult<OutboxJob>>;
  recoverInterruptedOutboxJob(
    input: RecoverInterruptedOutboxJobInput,
  ): Promise<OperationalStoreResult<OutboxJob>>;
  updateOutboxJobState(
    id: string,
    update: OutboxJobStateUpdate,
  ): Promise<OperationalStoreResult<OutboxJob>>;
};

export type SyncWorkspaceProvider = {
  getActiveWorkspaceId(): Promise<string | null>;
};

export type SyncClock = {
  now(): string;
};

export type SyncAssetReader = (localAccessKey: string) => Promise<Uint8Array>;

/**
 * Exponential-backoff-with-jitter policy for retryable sync failures. Replaces
 * the old single flat retry delay: a fixed gap makes every device and job
 * retry in lockstep, which the 2-core co-hosted server cannot absorb under
 * load. See `docs/design/OCR_OUTBOX_STATE_MACHINE.md` §4.
 */
export type RetryBackoffConfig = {
  /** Delay for the first retry (attempt 0), before any exponential growth. */
  baseMs: number;
  /** Hard ceiling on the exponential term, applied before jitter. */
  maxMs: number;
  /** Growth per attempt: delay approaches `baseMs * factor^attempt`. */
  factor: number;
  /** Fraction of the delay applied as symmetric random jitter to de-synchronize retries. */
  jitterRatio: number;
};

/** [0, 1) random source for backoff jitter; injectable so tests stay deterministic. */
export type RetryJitterSource = () => number;

export type SyncRunStatus =
  | 'idle'
  | 'skipped'
  | 'synced'
  | 'retry_wait'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export type SyncRunResult = {
  status: SyncRunStatus;
  processed: number;
  jobId?: string;
  code?: 'workspace_required' | 'backpressure_active' | 'offline' | 'server_unavailable';
};

export type SyncCancelResult = {
  cancelled: boolean;
  jobId: string;
};

export type SyncPresentationErrorCode =
  | 'unauthenticated'
  | 'workspace_required'
  | 'offline'
  | 'server_unavailable'
  | 'policy_denied'
  | 'quota_exceeded'
  | 'provider_not_configured'
  | 'provider_unavailable'
  | 'input_too_large'
  | 'unsupported_format'
  | 'validation_failed'
  | 'result_invalid'
  | 'cancelled'
  | 'unknown';

export type SyncQueueSummary = {
  pending: number;
  syncing: number;
  retrying: number;
  blocked: number;
  failed: number;
  backpressure?: {
    active: boolean;
    reasons: string[];
  };
  nextRetryAt?: string;
  lastError?: {
    code: SyncPresentationErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
};
