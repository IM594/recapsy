import type {
  AssetCacheRef,
  ClaimRetryableOutboxJobInput,
  HelperRuntimeState,
  OperationalStoreError,
  OperationalStoreRepository,
  OperationalStoreResult,
  OperationalStoreSnapshot,
  OutboxJob,
  OutboxJobCreateInput,
  OutboxJobListFilter,
  OutboxJobState,
  OutboxJobStateUpdate,
  OutboxSafeErrorInput,
  OutboxTerminalState,
  OutboxTerminalUpdate,
  PolicyCacheEntry,
  PolicyCacheRead,
  PolicyCacheReadOptions,
  SettingsCache,
  SyncCursor,
  SyncCursorKind,
} from './types';

export type InMemoryOperationalStoreOptions = {
  maxActiveOutboxJobs?: number;
};

const TERMINAL_OUTBOX_STATES = new Set<OutboxJobState>([
  'synced',
  'blocked',
  'failed',
  'cancelled',
]);

export function createInMemoryOperationalStore(
  options: InMemoryOperationalStoreOptions = {},
): OperationalStoreRepository {
  return new InMemoryOperationalStore(options);
}

class InMemoryOperationalStore implements OperationalStoreRepository {
  private readonly outboxJobs = new Map<string, OutboxJob>();
  private readonly assetRefs = new Map<string, AssetCacheRef>();
  private readonly policyCache = new Map<string, PolicyCacheEntry>();
  private readonly syncCursors = new Map<string, SyncCursor>();
  private readonly settingsCache = new Map<string, SettingsCache>();
  private helperState: HelperRuntimeState | null = null;

  constructor(private readonly options: InMemoryOperationalStoreOptions) {}

  async createOutboxJob(job: OutboxJobCreateInput): Promise<OperationalStoreResult<OutboxJob>> {
    const activeJobCount = [...this.outboxJobs.values()].filter(
      (entry) => !isTerminalOutboxState(entry.state),
    ).length;

    if (
      this.options.maxActiveOutboxJobs !== undefined &&
      activeJobCount >= this.options.maxActiveOutboxJobs
    ) {
      return failure({
        code: 'capacity_exceeded',
        message: 'Outbox active job capacity has been reached.',
      });
    }

    const idempotencyConflict = [...this.outboxJobs.values()].some(
      (entry) =>
        entry.workspaceId === job.workspaceId && entry.idempotencyKey === job.idempotencyKey,
    );

    if (idempotencyConflict) {
      return failure({
        code: 'idempotency_key_conflict',
        message: 'Outbox idempotency key already exists for this workspace.',
      });
    }

    const created: OutboxJob = {
      assetRefId: job.assetRefId,
      attempt: 0,
      createdAt: job.createdAt,
      deviceId: job.deviceId,
      id: job.id,
      idempotencyKey: job.idempotencyKey,
      payloadHash: job.payloadHash,
      state: 'pending',
      updatedAt: job.createdAt,
      workspaceId: job.workspaceId,
      ...(job.nextRetryAt ? { nextRetryAt: job.nextRetryAt } : {}),
    };

    this.outboxJobs.set(job.id, created);

    return success(cloneOutboxJob(created));
  }

  async getOutboxJob(id: string): Promise<OutboxJob | null> {
    const job = this.outboxJobs.get(id);
    return job ? cloneOutboxJob(job) : null;
  }

  async listOutboxJobs(filter: OutboxJobListFilter = {}): Promise<OutboxJob[]> {
    return [...this.outboxJobs.values()]
      .filter((job) => (filter.workspaceId ? job.workspaceId === filter.workspaceId : true))
      .filter((job) => (filter.state ? job.state === filter.state : true))
      .map(cloneOutboxJob);
  }

  async updateOutboxJobState(
    id: string,
    update: OutboxJobStateUpdate,
  ): Promise<OperationalStoreResult<OutboxJob>> {
    const job = this.outboxJobs.get(id);

    if (!job) {
      return failure(notFound('outbox_job_not_found', 'Outbox job was not found.'));
    }

    if (isTerminalOutboxState(job.state) && !isTerminalOutboxState(update.state)) {
      return failure(terminalTransitionConflict());
    }

    const updated: OutboxJob = {
      ...job,
      state: update.state,
      updatedAt: update.now,
      ...(update.nextRetryAt ? { nextRetryAt: update.nextRetryAt } : {}),
      ...(update.serverCaptureId ? { serverCaptureId: update.serverCaptureId } : {}),
      ...(update.serverOcrJobId ? { serverOcrJobId: update.serverOcrJobId } : {}),
    };

    if (update.state === 'uploading') {
      updated.lockedAt = update.now;
    }

    this.outboxJobs.set(id, updated);

    return success(cloneOutboxJob(updated));
  }

  async claimNextRetryableOutboxJob(
    input: ClaimRetryableOutboxJobInput,
  ): Promise<OutboxJob | null> {
    const candidates = [...this.outboxJobs.values()]
      .filter((job) => job.workspaceId === input.workspaceId)
      .filter((job) => job.state === 'pending')
      .filter((job) => job.attempt < input.maxAttempts)
      .filter((job) => !job.nextRetryAt || job.nextRetryAt <= input.now)
      .sort(compareRetryableJobs);

    const job = candidates[0];

    if (!job) {
      return null;
    }

    const claimed: OutboxJob = {
      ...job,
      lockedAt: input.now,
      state: 'uploading',
      updatedAt: input.now,
    };

    this.outboxJobs.set(job.id, claimed);

    return cloneOutboxJob(claimed);
  }

  async markOutboxJobTerminal(
    id: string,
    update: OutboxTerminalUpdate,
  ): Promise<OperationalStoreResult<OutboxJob>> {
    const job = this.outboxJobs.get(id);

    if (!job) {
      return failure(notFound('outbox_job_not_found', 'Outbox job was not found.'));
    }

    const updated: OutboxJob = {
      ...job,
      lockedAt: undefined,
      nextRetryAt: undefined,
      state: update.state,
      terminalReason: update.reason,
      updatedAt: update.now,
      ...(update.serverCaptureId ? { serverCaptureId: update.serverCaptureId } : {}),
      ...(update.serverOcrJobId ? { serverOcrJobId: update.serverOcrJobId } : {}),
    };

    this.outboxJobs.set(id, updated);

    return success(cloneOutboxJob(updated));
  }

  async recordOutboxSafeError(
    id: string,
    input: OutboxSafeErrorInput,
  ): Promise<OperationalStoreResult<OutboxJob>> {
    const job = this.outboxJobs.get(id);

    if (!job) {
      return failure(notFound('outbox_job_not_found', 'Outbox job was not found.'));
    }

    if (isTerminalOutboxState(job.state)) {
      return failure({
        code: 'terminal_state_conflict',
        message: 'Terminal outbox jobs cannot be retried.',
      });
    }

    const attempt = job.attempt + 1;
    const retryable = input.retryable && attempt < input.maxAttempts;
    const state: OutboxJobState = retryable ? 'pending' : 'failed';
    const updated: OutboxJob = {
      ...job,
      attempt,
      lastSafeError: {
        code: input.code,
        message: input.message,
        retryable: input.retryable,
      },
      lockedAt: undefined,
      state,
      updatedAt: input.now,
    };

    if (retryable && input.retryAt) {
      updated.nextRetryAt = input.retryAt;
    } else {
      updated.nextRetryAt = undefined;
      updated.terminalReason = input.code;
    }

    this.outboxJobs.set(id, updated);

    return success(cloneOutboxJob(updated));
  }

  async upsertAssetCacheRef(asset: AssetCacheRef): Promise<AssetCacheRef> {
    const cloned = cloneAssetRef(asset);
    this.assetRefs.set(asset.assetRefId, cloned);
    return cloneAssetRef(cloned);
  }

  async getAssetCacheRef(assetRefId: string): Promise<AssetCacheRef | null> {
    const asset = this.assetRefs.get(assetRefId);
    return asset ? cloneAssetRef(asset) : null;
  }

  async listAssetCacheRefs(workspaceId: string): Promise<AssetCacheRef[]> {
    return [...this.assetRefs.values()]
      .filter((asset) => asset.workspaceId === workspaceId)
      .map(cloneAssetRef);
  }

  async deleteAssetCacheRef(assetRefId: string): Promise<boolean> {
    return this.assetRefs.delete(assetRefId);
  }

  async setHelperState(state: HelperRuntimeState): Promise<HelperRuntimeState> {
    this.helperState = cloneHelperState(state);
    return cloneHelperState(this.helperState);
  }

  async getHelperState(): Promise<HelperRuntimeState | null> {
    return this.helperState ? cloneHelperState(this.helperState) : null;
  }

  async setPolicyCache(entry: PolicyCacheEntry): Promise<PolicyCacheEntry> {
    const cloned = clonePolicyCache(entry);
    this.policyCache.set(entry.workspaceId, cloned);
    return clonePolicyCache(cloned);
  }

  async getPolicyCache(
    workspaceId: string,
    options: PolicyCacheReadOptions,
  ): Promise<PolicyCacheRead | null> {
    const entry = this.policyCache.get(workspaceId);

    if (!entry) {
      return null;
    }

    return {
      ...clonePolicyCache(entry),
      expired: isExpired(entry.fetchedAt, entry.ttlSeconds, options.now),
    };
  }

  async setSyncCursor(cursor: SyncCursor): Promise<SyncCursor> {
    const cloned = cloneSyncCursor(cursor);
    this.syncCursors.set(syncCursorKey(cursor.workspaceId, cursor.kind), cloned);
    return cloneSyncCursor(cloned);
  }

  async getSyncCursor(workspaceId: string, kind: SyncCursorKind): Promise<SyncCursor | null> {
    const cursor = this.syncCursors.get(syncCursorKey(workspaceId, kind));
    return cursor ? cloneSyncCursor(cursor) : null;
  }

  async setSettingsCache(settings: SettingsCache): Promise<SettingsCache> {
    const cloned = cloneSettingsCache(settings);
    this.settingsCache.set(settings.workspaceId, cloned);
    return cloneSettingsCache(cloned);
  }

  async getSettingsCache(workspaceId: string): Promise<SettingsCache | null> {
    const settings = this.settingsCache.get(workspaceId);
    return settings ? cloneSettingsCache(settings) : null;
  }

  async getBackpressureSnapshot(workspaceId: string): Promise<OperationalStoreSnapshot> {
    const jobs = [...this.outboxJobs.values()].filter((job) => job.workspaceId === workspaceId);
    const assetBytes = [...this.assetRefs.values()]
      .filter((asset) => asset.workspaceId === workspaceId && asset.cleanupState !== 'cleaned')
      .reduce((total, asset) => total + asset.sizeBytes, 0);

    return {
      assetBytes,
      maxAttempt: jobs.reduce((max, job) => Math.max(max, job.attempt), 0),
      queuedJobs: jobs.filter((job) => !isTerminalOutboxState(job.state)).length,
    };
  }

  async clearWorkspaceCache(workspaceId: string): Promise<void> {
    deleteMatching(this.outboxJobs, (job) => job.workspaceId === workspaceId);
    deleteMatching(this.assetRefs, (asset) => asset.workspaceId === workspaceId);
    this.policyCache.delete(workspaceId);
    deleteMatching(this.syncCursors, (cursor) => cursor.workspaceId === workspaceId);
    this.settingsCache.delete(workspaceId);
  }

  async clearSignOutCache(): Promise<void> {
    this.outboxJobs.clear();
    this.assetRefs.clear();
    this.policyCache.clear();
    this.syncCursors.clear();
    this.settingsCache.clear();
    this.helperState = null;
  }
}

function compareRetryableJobs(left: OutboxJob, right: OutboxJob): number {
  const leftRetry = left.nextRetryAt ?? left.createdAt;
  const rightRetry = right.nextRetryAt ?? right.createdAt;

  if (leftRetry !== rightRetry) {
    return leftRetry.localeCompare(rightRetry);
  }

  return left.createdAt.localeCompare(right.createdAt);
}

function isTerminalOutboxState(state: OutboxJobState): state is OutboxTerminalState {
  return TERMINAL_OUTBOX_STATES.has(state);
}

function terminalTransitionConflict(): OperationalStoreError {
  return {
    code: 'terminal_state_conflict',
    message: 'Terminal outbox jobs cannot transition to a non-terminal state.',
  };
}

function notFound(code: OperationalStoreError['code'], message: string): OperationalStoreError {
  return {
    code,
    message,
  };
}

function success<T>(value: T): OperationalStoreResult<T> {
  return {
    ok: true,
    value,
  };
}

function failure<T>(error: OperationalStoreError): OperationalStoreResult<T> {
  return {
    error,
    ok: false,
  };
}

function isExpired(fetchedAt: string, ttlSeconds: number, now: string): boolean {
  return Date.parse(now) > Date.parse(fetchedAt) + ttlSeconds * 1000;
}

function syncCursorKey(workspaceId: string, kind: SyncCursorKind): string {
  return `${workspaceId}:${kind}`;
}

function deleteMatching<T>(map: Map<string, T>, predicate: (value: T) => boolean): void {
  for (const [key, value] of map.entries()) {
    if (predicate(value)) {
      map.delete(key);
    }
  }
}

function cloneOutboxJob(job: OutboxJob): OutboxJob {
  return {
    ...job,
    ...(job.lastSafeError ? { lastSafeError: { ...job.lastSafeError } } : {}),
  };
}

function cloneAssetRef(asset: AssetCacheRef): AssetCacheRef {
  return { ...asset };
}

function cloneHelperState(state: HelperRuntimeState): HelperRuntimeState {
  return {
    ...state,
    ...(state.lastSafeError ? { lastSafeError: { ...state.lastSafeError } } : {}),
    permissions: {
      ...state.permissions,
    },
  };
}

function clonePolicyCache(entry: PolicyCacheEntry): PolicyCacheEntry {
  return {
    ...entry,
    actions: [...entry.actions],
  };
}

function cloneSyncCursor(cursor: SyncCursor): SyncCursor {
  return { ...cursor };
}

function cloneSettingsCache(settings: SettingsCache): SettingsCache {
  return {
    ...settings,
    serverCapabilities: {
      ...settings.serverCapabilities,
    },
  };
}
