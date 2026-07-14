import type {
  CaptureOutboxEntryCreateInput,
  HelperRuntimeState,
  OperationalStoreResult,
  OperationalStoreSnapshot,
  OutboxJob,
  OutboxJobListFilter,
} from '../storage/public';

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

export type CaptureHistoryReader = {
  listOutboxJobs(filter?: OutboxJobListFilter): Promise<OutboxJob[]>;
};
