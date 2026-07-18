import type {
  CaptureOutboxEntryCreateInput,
  HelperRuntimeState,
  LocalCapturePolicyRule,
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
  deleteLocalCapturePolicyRule(id: string): Promise<boolean>;
  getPolicyCache(
    workspaceId: string,
    deviceId: string,
    options: { now: string },
  ): Promise<PolicyCacheRead | null>;
  setPolicyCache(entry: PolicyCacheEntry): Promise<PolicyCacheEntry>;
  listLocalCapturePolicyRules(): Promise<LocalCapturePolicyRule[]>;
  upsertLocalCapturePolicyRule(rule: LocalCapturePolicyRule): Promise<LocalCapturePolicyRule>;
};

export type CaptureHistoryReader = {
  listOutboxJobs(filter?: OutboxJobListFilter): Promise<OutboxJob[]>;
};
