import type {
  CaptureCoverageSegmentRecord,
  CaptureOutboxEntryCreateInput,
  CloseOpenCoverageSegmentInput,
  DeviceCaptureLivenessRecord,
  ExtendOpenCoverageSegmentInput,
  LocalCapturePolicyRule,
  OpenCoverageSegmentInput,
  OpenCoverageSegmentRecord,
  OperationalStoreResult,
  OutboxJob,
  OutboxJobListFilter,
  PolicyCacheEntry,
  PolicyCacheRead,
  RecoverHangingCoverageSegmentInput,
  UpsertDeviceCaptureLivenessInput,
} from '../storage/index';

export type CaptureIntakeStore = {
  createCaptureOutboxEntry(
    entry: CaptureOutboxEntryCreateInput,
  ): Promise<OperationalStoreResult<OutboxJob>>;
};

/**
 * Local persistence for the capture-coverage spine: run-length segments plus
 * this device's own liveness row (see `storage/sqlite/coverage.ts`). Consumed
 * by `capture/runtime.ts` to back the shared `CoverageAggregator` instance,
 * and by `sync/coverage-job.ts` to read what still needs to sync.
 */
export type CaptureCoverageStore = {
  openCoverageSegment(input: OpenCoverageSegmentInput): Promise<void>;
  extendOpenCoverageSegment(input: ExtendOpenCoverageSegmentInput): Promise<void>;
  closeOpenCoverageSegment(
    input: CloseOpenCoverageSegmentInput,
  ): Promise<CaptureCoverageSegmentRecord | null>;
  recoverHangingCoverageSegment(input: RecoverHangingCoverageSegmentInput): Promise<void>;
  listPendingCoverageSegments(workspaceId?: string): Promise<CaptureCoverageSegmentRecord[]>;
  markCoverageSegmentsSynced(ids: readonly string[]): Promise<void>;
  getOpenCoverageSegment(
    workspaceId: string,
    deviceId: string,
  ): Promise<OpenCoverageSegmentRecord | null>;
  getDeviceCaptureLiveness(
    workspaceId: string,
    deviceId: string,
  ): Promise<DeviceCaptureLivenessRecord | null>;
  upsertDeviceCaptureLiveness(
    input: UpsertDeviceCaptureLivenessInput,
  ): Promise<DeviceCaptureLivenessRecord>;
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
