import type { ServerApiClient } from '../server-api/types';
import type { BackpressureDecision, OperationalStoreRepository } from '../storage/types';

export type SyncServerApi = ServerApiClient;

export type SyncWorkspaceProvider = {
  getActiveWorkspaceId(): Promise<string | null>;
};

export type SyncClock = {
  now(): string;
};

export type SyncAssetReader = (localAccessKey: string) => Promise<Uint8Array>;

export type SyncSchedulerOptions = {
  store: OperationalStoreRepository;
  api: SyncServerApi;
  workspace: SyncWorkspaceProvider;
  readAssetBytes: SyncAssetReader;
  clock: SyncClock;
  maxAttempts: number;
  retryDelayMs: number;
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
