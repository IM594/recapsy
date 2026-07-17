import type {
  CaptureOutboxEntryCreateInput,
  HelperRuntimeState,
  OperationalStoreResult,
  OperationalStoreSnapshot,
  OutboxJob,
  OutboxJobListFilter,
  PolicyCacheEntry,
  PolicyCacheRead,
} from '../storage/index';

export type CaptureIntakeStore = {
  createCaptureOutboxEntry(
    entry: CaptureOutboxEntryCreateInput,
  ): Promise<OperationalStoreResult<OutboxJob>>;
  getBackpressureSnapshot(workspaceId: string): Promise<OperationalStoreSnapshot>;
};

export type HelperStateStore = {
  setHelperState(state: HelperRuntimeState): Promise<HelperRuntimeState>;
  getHelperState(): Promise<HelperRuntimeState | null>;
};

export type CapturePolicyCacheStore = {
  getPolicyCache(
    workspaceId: string,
    deviceId: string,
    options: { now: string },
  ): Promise<PolicyCacheRead | null>;
  setPolicyCache(entry: PolicyCacheEntry): Promise<PolicyCacheEntry>;
};

export type CaptureHistoryReader = {
  listOutboxJobs(filter?: OutboxJobListFilter): Promise<OutboxJob[]>;
};
