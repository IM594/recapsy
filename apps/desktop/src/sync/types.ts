import type { ServerApiClient, ServerApiOcrProxyClient } from '../server-api/types';
import type { BackpressureDecision, OperationalStoreRepository } from '../storage/types';

export type SyncServerApi = ServerApiClient & ServerApiOcrProxyClient;

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

export type SyncSchedulerOptions = {
  store: OperationalStoreRepository;
  api: SyncServerApi;
  workspace: SyncWorkspaceProvider;
  readAssetBytes: SyncAssetReader;
  clock: SyncClock;
  maxAttempts: number;
  retryBackoff: RetryBackoffConfig;
  /** Overrides the jitter random source; defaults to `Math.random` in the scheduler. */
  jitterRandom?: RetryJitterSource;
  backpressure?: BackpressureDecision;
};

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
