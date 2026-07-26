import { randomUUID } from 'node:crypto';
import { assetRefMatches, cloneAssetRef } from './asset-values';
import {
  cloneLocalCapturePolicyRule,
  clonePolicyCache,
  cloneSettingsCache,
  cloneSyncCursor,
} from './cache-values';
import {
  capturePayloadMatches,
  cloneOutboxJob,
  cloneStoredOcrResult,
  createPendingOutboxJob,
  normalizeCapturePayload,
  requiresLocalAssetBytes,
} from './outbox-values';
import { settleServerCapture as settleStoredServerCapture } from './reconciliation';
import type {
  AssetCacheRef,
  CaptureCoverageSegmentRecord,
  CaptureOutboxEntryCreateInput,
  ClaimAssetCleanupInput,
  ClaimRetryableOutboxJobInput,
  CloseOpenCoverageSegmentInput,
  DeviceCaptureLivenessRecord,
  ExtendOpenCoverageSegmentInput,
  LocalCapturePolicyRule,
  OpenCoverageSegmentInput,
  OpenCoverageSegmentRecord,
  OperationalStoreError,
  OperationalStoreResult,
  OperationalStoreSnapshot,
  OutboxJob,
  OutboxJobCreateInput,
  OutboxJobListFilter,
  OutboxJobState,
  OutboxJobStateUpdate,
  OutboxQueueSummary,
  OutboxSafeErrorInput,
  OutboxTerminalState,
  OutboxTerminalUpdate,
  PolicyCacheEntry,
  PolicyCacheRead,
  PolicyCacheReadOptions,
  RecoverHangingCoverageSegmentInput,
  RecoverInterruptedOutboxJobInput,
  RecoverPendingAssetCleanupInput,
  ReleaseOutboxJobInput,
  RequeueTerminalOutboxJobsInput,
  ServerCaptureSettlement,
  ServerCaptureSettlementInput,
  SetAssetCleanupStateInput,
  SettingsCache,
  SyncCursor,
  SyncCursorKind,
  UpdateAssetRefAvailabilityInput,
  UpsertDeviceCaptureLivenessInput,
} from './types';

type InMemoryDeviceLiveness = DeviceCaptureLivenessRecord & {
  openCoverage?: OpenCoverageSegmentRecord;
};

export type MemoryStoreOptions = {
  maxActiveOutboxJobs?: number;
};

const TERMINAL_OUTBOX_STATES = new Set<OutboxJobState>([
  'synced',
  'blocked',
  'failed',
  'cancelled',
]);

export function createMemoryStore(options: MemoryStoreOptions = {}) {
  return new InMemoryOperationalStore(options);
}

class InMemoryOperationalStore {
  private readonly outboxJobs = new Map<string, OutboxJob>();
  private readonly assetRefs = new Map<string, AssetCacheRef>();
  private readonly policyCache = new Map<string, PolicyCacheEntry>();
  private readonly localCapturePolicyRules = new Map<string, LocalCapturePolicyRule>();
  private readonly syncCursors = new Map<string, SyncCursor>();
  private readonly settingsCache = new Map<string, SettingsCache>();
  private readonly coverageSegments = new Map<string, CaptureCoverageSegmentRecord>();
  private readonly deviceLiveness = new Map<string, InMemoryDeviceLiveness>();

  constructor(private readonly options: MemoryStoreOptions) {}

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

    if (this.outboxJobs.has(job.id)) {
      return failure({
        code: 'outbox_job_id_conflict',
        message: 'Outbox job id already exists.',
      });
    }

    const created = createPendingOutboxJob(job);

    this.outboxJobs.set(job.id, created);

    return success(cloneOutboxJob(created));
  }

  async createCaptureOutboxEntry(
    entry: CaptureOutboxEntryCreateInput,
  ): Promise<OperationalStoreResult<OutboxJob>> {
    const idempotencyConflict = [...this.outboxJobs.values()].find(
      (job) => job.workspaceId === entry.workspaceId && job.idempotencyKey === entry.idempotencyKey,
    );

    if (idempotencyConflict) {
      return existingCaptureOutboxEntryMatches(idempotencyConflict, entry, this.assetRefs)
        ? success(cloneOutboxJob(idempotencyConflict))
        : failure({
            code: 'idempotency_key_conflict',
            message: 'Outbox idempotency key already exists for this workspace.',
          });
    }

    const activeJobCount = [...this.outboxJobs.values()].filter(
      (job) => !isTerminalOutboxState(job.state),
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

    if (this.outboxJobs.has(entry.id)) {
      return failure({
        code: 'outbox_job_id_conflict',
        message: 'Outbox job id already exists.',
      });
    }

    for (const assetRef of entry.assetRefs) {
      const existing = this.assetRefs.get(assetRef.assetRefId);

      if (existing && !assetRefMatches(existing, assetRef)) {
        return failure({
          code: 'asset_ref_conflict',
          message: 'Asset ref already exists with different metadata.',
        });
      }
    }

    const created = createPendingOutboxJob(entry);

    for (const assetRef of entry.assetRefs) {
      this.assetRefs.set(assetRef.assetRefId, cloneAssetRef(assetRef));
    }

    this.outboxJobs.set(entry.id, created);

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

  async listInterruptedOutboxJobs(workspaceId?: string): Promise<OutboxJob[]> {
    return [...this.outboxJobs.values()]
      .filter((job) => (workspaceId ? job.workspaceId === workspaceId : true))
      .filter((job) => job.state === 'syncing' || job.state === 'result_pending')
      .sort(compareOutboxJobs)
      .map(cloneOutboxJob);
  }

  async listActiveAssetRefDependencies(
    workspaceId?: string,
  ): Promise<Array<{ asset: AssetCacheRef; jobs: OutboxJob[] }>> {
    const jobsByAssetRef = groupActiveAssetDependencies(this.outboxJobs.values(), workspaceId);

    return [...jobsByAssetRef.entries()]
      .flatMap(([assetRefId, jobs]) => {
        const asset = this.assetRefs.get(assetRefId);
        return asset ? [{ asset: cloneAssetRef(asset), jobs: jobs.map(cloneOutboxJob) }] : [];
      })
      .sort((left, right) => left.asset.assetRefId.localeCompare(right.asset.assetRefId));
  }

  async listHistoricalAssetRefPage(input: {
    afterAssetRefId?: string;
    limit: number;
    workspaceId?: string;
  }): Promise<AssetCacheRef[]> {
    const activeAssetRefIds = new Set(
      groupActiveAssetDependencies(this.outboxJobs.values(), input.workspaceId).keys(),
    );

    return [...this.assetRefs.values()]
      .filter((asset) => (input.workspaceId ? asset.workspaceId === input.workspaceId : true))
      .filter((asset) => !input.afterAssetRefId || asset.assetRefId > input.afterAssetRefId)
      .filter((asset) => !activeAssetRefIds.has(asset.assetRefId))
      .sort((left, right) => left.assetRefId.localeCompare(right.assetRefId))
      .slice(0, input.limit)
      .map(cloneAssetRef);
  }

  async updateOutboxJobState(
    id: string,
    update: OutboxJobStateUpdate,
  ): Promise<OperationalStoreResult<OutboxJob>> {
    const job = this.outboxJobs.get(id);

    if (!job) {
      return failure(notFound('outbox_job_not_found', 'Outbox job was not found.'));
    }

    if (isTerminalOutboxState(job.state)) {
      return failure(terminalTransitionConflict());
    }
    if (!leaseMatches(job, update.leaseToken)) {
      return failure(leaseLost());
    }

    const updated: OutboxJob = {
      ...job,
      state: update.state,
      updatedAt: update.now,
      ...(update.nextRetryAt ? { nextRetryAt: update.nextRetryAt } : {}),
      ...(update.serverCaptureId ? { serverCaptureId: update.serverCaptureId } : {}),
      ...(update.ocrResult ? { ocrResult: cloneStoredOcrResult(update.ocrResult) } : {}),
    };

    if (update.state === 'syncing') {
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
      leaseExpiresAt: new Date(Date.parse(input.now) + OUTBOX_LEASE_DURATION_MS).toISOString(),
      leaseToken: randomUUID(),
      lockedAt: input.now,
      nextRetryAt: undefined,
      state: 'syncing',
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

    if (isTerminalOutboxState(job.state)) {
      return failure({
        code: 'terminal_state_conflict',
        message: 'Terminal outbox jobs cannot transition to another terminal state.',
      });
    }
    if (!leaseMatches(job, update.leaseToken)) {
      return failure(leaseLost());
    }

    const updated: OutboxJob = {
      ...job,
      lastSafeError: update.lastSafeError ? { ...update.lastSafeError } : undefined,
      lockedAt: undefined,
      leaseExpiresAt: undefined,
      leaseToken: undefined,
      nextRetryAt: undefined,
      state: update.state,
      terminalReason: update.reason,
      updatedAt: update.now,
      ...(update.serverCaptureId ? { serverCaptureId: update.serverCaptureId } : {}),
    };

    this.outboxJobs.set(id, updated);

    return success(cloneOutboxJob(updated));
  }

  settleServerCapture(input: ServerCaptureSettlementInput): Promise<ServerCaptureSettlement> {
    return settleStoredServerCapture(this, input);
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
    if (!leaseMatches(job, input.leaseToken)) {
      return failure(leaseLost());
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
      leaseExpiresAt: undefined,
      leaseToken: undefined,
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

  async releaseOutboxJob(input: ReleaseOutboxJobInput): Promise<OperationalStoreResult<OutboxJob>> {
    const job = this.outboxJobs.get(input.id);
    if (!job) {
      return failure(notFound('outbox_job_not_found', 'Outbox job was not found.'));
    }
    if (isTerminalOutboxState(job.state)) {
      return failure(terminalTransitionConflict());
    }
    if (!leaseMatches(job, input.leaseToken)) {
      return failure(leaseLost());
    }

    const updated: OutboxJob = {
      ...job,
      lastSafeError: { ...input.lastSafeError },
      leaseExpiresAt: undefined,
      leaseToken: undefined,
      lockedAt: undefined,
      nextRetryAt: input.now,
      state: 'pending',
      terminalReason: undefined,
      updatedAt: input.now,
    };
    this.outboxJobs.set(input.id, updated);
    return success(cloneOutboxJob(updated));
  }

  async requeueTerminalOutboxJobs(input: RequeueTerminalOutboxJobsInput): Promise<number> {
    let requeued = 0;
    for (const [id, job] of this.outboxJobs) {
      if (job.workspaceId !== input.workspaceId) continue;
      if (job.state !== 'failed' && job.state !== 'blocked') continue;
      this.outboxJobs.set(id, {
        ...job,
        attempt: 0,
        lastSafeError: undefined,
        leaseExpiresAt: undefined,
        leaseToken: undefined,
        lockedAt: undefined,
        nextRetryAt: input.now,
        state: 'pending',
        terminalReason: undefined,
        updatedAt: input.now,
      });
      requeued += 1;
    }
    return requeued;
  }

  async recoverInterruptedOutboxJob(
    input: RecoverInterruptedOutboxJobInput,
  ): Promise<OperationalStoreResult<OutboxJob>> {
    const job = this.outboxJobs.get(input.id);

    if (!job) {
      return failure(notFound('outbox_job_not_found', 'Outbox job was not found.'));
    }

    if (isTerminalOutboxState(job.state)) {
      return failure(terminalTransitionConflict());
    }

    if (job.state !== 'syncing' && job.state !== 'result_pending') {
      return failure({
        code: 'terminal_state_conflict',
        message: 'Only interrupted outbox jobs can be recovered at startup.',
      });
    }
    if (!leaseMatches(job, input.leaseToken)) {
      return failure(leaseLost());
    }

    const updated: OutboxJob = {
      ...job,
      lastSafeError: { ...input.lastSafeError },
      lockedAt: undefined,
      leaseExpiresAt: undefined,
      leaseToken: undefined,
      nextRetryAt: input.nextRetryAt,
      state: 'pending',
      terminalReason: undefined,
      updatedAt: input.now,
    };

    this.outboxJobs.set(input.id, updated);

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

  async listAssetCacheRefs(workspaceId?: string): Promise<AssetCacheRef[]> {
    return [...this.assetRefs.values()]
      .filter((asset) => (workspaceId ? asset.workspaceId === workspaceId : true))
      .map(cloneAssetRef);
  }

  async updateAssetRefAvailability(
    input: UpdateAssetRefAvailabilityInput,
  ): Promise<OperationalStoreResult<AssetCacheRef>> {
    const asset = this.assetRefs.get(input.assetRefId);

    if (!asset) {
      return failure(notFound('asset_ref_not_found', 'Asset ref was not found.'));
    }

    const updated: AssetCacheRef = {
      ...asset,
      availabilityCheckedAt: input.now,
      availabilitySafeError: input.availabilitySafeError
        ? { ...input.availabilitySafeError }
        : undefined,
      availabilityState: input.availabilityState,
    };

    this.assetRefs.set(input.assetRefId, updated);

    return success(cloneAssetRef(updated));
  }

  async claimAssetCleanup(input: ClaimAssetCleanupInput): Promise<AssetCacheRef | null> {
    const asset = this.assetRefs.get(input.assetRefId);

    if (!asset || (asset.cleanupState !== 'retained' && asset.cleanupState !== 'cleanup_failed')) {
      return null;
    }

    const claimed: AssetCacheRef = {
      ...asset,
      cleanupSafeError: undefined,
      cleanupState: 'cleanup_pending',
      cleanupUpdatedAt: input.now,
    };
    this.assetRefs.set(input.assetRefId, claimed);
    return cloneAssetRef(claimed);
  }

  async settleAssetCleanup(
    input: SetAssetCleanupStateInput,
  ): Promise<OperationalStoreResult<AssetCacheRef>> {
    const asset = this.assetRefs.get(input.assetRefId);

    if (!asset) {
      return failure(notFound('asset_ref_not_found', 'Asset ref was not found.'));
    }
    if (asset.cleanupState !== 'cleanup_pending') {
      return failure({
        code: 'asset_cleanup_conflict',
        message: 'Asset cleanup is no longer pending.',
      });
    }

    const updated: AssetCacheRef = {
      ...asset,
      availabilityCheckedAt:
        input.cleanupState === 'cleaned' ? input.now : asset.availabilityCheckedAt,
      availabilitySafeError:
        input.cleanupState === 'cleaned' ? undefined : asset.availabilitySafeError,
      availabilityState: input.cleanupState === 'cleaned' ? 'missing' : asset.availabilityState,
      cleanupSafeError: input.cleanupSafeError ? { ...input.cleanupSafeError } : undefined,
      cleanupState: input.cleanupState,
      cleanupUpdatedAt: input.now,
    };
    this.assetRefs.set(input.assetRefId, updated);
    return success(cloneAssetRef(updated));
  }

  async recoverPendingAssetCleanup(input: RecoverPendingAssetCleanupInput): Promise<number> {
    let recovered = 0;

    for (const [assetRefId, asset] of this.assetRefs) {
      if (asset.workspaceId !== input.workspaceId || asset.cleanupState !== 'cleanup_pending') {
        continue;
      }
      this.assetRefs.set(assetRefId, {
        ...asset,
        cleanupSafeError: {
          code: 'local_asset_cleanup_interrupted',
          message: 'Local asset cleanup was interrupted.',
          retryable: true,
        },
        cleanupState: 'cleanup_failed',
        cleanupUpdatedAt: input.now,
      });
      recovered += 1;
    }

    return recovered;
  }

  async deleteAssetCacheRef(assetRefId: string): Promise<boolean> {
    return this.assetRefs.delete(assetRefId);
  }

  async setPolicyCache(entry: PolicyCacheEntry): Promise<PolicyCacheEntry> {
    const cloned = clonePolicyCache(entry);
    this.policyCache.set(policyCacheKey(entry.workspaceId, entry.deviceId), cloned);
    return clonePolicyCache(cloned);
  }

  async getPolicyCache(
    workspaceId: string,
    deviceId: string,
    options: PolicyCacheReadOptions,
  ): Promise<PolicyCacheRead | null> {
    const entry = this.policyCache.get(policyCacheKey(workspaceId, deviceId));

    if (!entry) {
      return null;
    }

    return {
      ...clonePolicyCache(entry),
      expired: isExpired(entry.fetchedAt, entry.ttlSeconds, options.now),
    };
  }

  async upsertLocalCapturePolicyRule(
    rule: LocalCapturePolicyRule,
  ): Promise<LocalCapturePolicyRule> {
    const cloned = cloneLocalCapturePolicyRule(rule);
    this.localCapturePolicyRules.set(rule.id, cloned);
    return cloneLocalCapturePolicyRule(cloned);
  }

  async listLocalCapturePolicyRules(): Promise<LocalCapturePolicyRule[]> {
    return [...this.localCapturePolicyRules.values()]
      .sort(compareLocalCapturePolicyRules)
      .map(cloneLocalCapturePolicyRule);
  }

  async deleteLocalCapturePolicyRule(id: string): Promise<boolean> {
    return this.localCapturePolicyRules.delete(id);
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

  async openCoverageSegment(input: OpenCoverageSegmentInput): Promise<void> {
    const key = livenessKey(input.workspaceId, input.deviceId);
    const existing = this.deviceLiveness.get(key);
    this.deviceLiveness.set(key, {
      deviceId: input.deviceId,
      desiredState: existing?.desiredState ?? 'running',
      lastAliveAt: existing?.lastAliveAt ?? input.now,
      openCoverage: {
        coverageState: input.coverageState,
        intervalMs: input.intervalMs,
        startedAt: input.startedAt,
        tickCount: 1,
      },
      updatedAt: input.now,
      workspaceId: input.workspaceId,
    });
  }

  async extendOpenCoverageSegment(input: ExtendOpenCoverageSegmentInput): Promise<void> {
    const key = livenessKey(input.workspaceId, input.deviceId);
    const existing = this.deviceLiveness.get(key);
    if (!existing?.openCoverage) return;

    this.deviceLiveness.set(key, {
      ...existing,
      openCoverage: { ...existing.openCoverage, tickCount: input.tickCount },
      updatedAt: input.now,
    });
  }

  async closeOpenCoverageSegment(
    input: CloseOpenCoverageSegmentInput,
  ): Promise<CaptureCoverageSegmentRecord | null> {
    return this.closeOpenSegment(
      input.workspaceId,
      input.deviceId,
      input.endedAt,
      input.closeReason,
      input.now,
    );
  }

  async recoverHangingCoverageSegment(input: RecoverHangingCoverageSegmentInput): Promise<void> {
    const existing = this.deviceLiveness.get(livenessKey(input.workspaceId, input.deviceId));
    if (!existing?.openCoverage) return;

    const endedAt = existing.lastAliveAt ?? existing.openCoverage.startedAt;
    this.closeOpenSegment(
      input.workspaceId,
      input.deviceId,
      endedAt,
      'inferred_on_recovery',
      input.now,
    );
  }

  async listPendingCoverageSegments(workspaceId?: string): Promise<CaptureCoverageSegmentRecord[]> {
    return [...this.coverageSegments.values()]
      .filter((segment) => segment.syncState === 'pending')
      .filter((segment) => (workspaceId ? segment.workspaceId === workspaceId : true))
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .map((segment) => ({ ...segment }));
  }

  async markCoverageSegmentsSynced(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const segment = this.coverageSegments.get(id);
      if (segment) this.coverageSegments.set(id, { ...segment, syncState: 'synced' });
    }
  }

  async getOpenCoverageSegment(
    workspaceId: string,
    deviceId: string,
  ): Promise<OpenCoverageSegmentRecord | null> {
    const openCoverage = this.deviceLiveness.get(livenessKey(workspaceId, deviceId))?.openCoverage;
    return openCoverage ? { ...openCoverage } : null;
  }

  async getDeviceCaptureLiveness(
    workspaceId: string,
    deviceId: string,
  ): Promise<DeviceCaptureLivenessRecord | null> {
    const liveness = this.deviceLiveness.get(livenessKey(workspaceId, deviceId));
    if (!liveness) return null;
    const { openCoverage: _openCoverage, ...record } = liveness;
    return { ...record };
  }

  async upsertDeviceCaptureLiveness(
    input: UpsertDeviceCaptureLivenessInput,
  ): Promise<DeviceCaptureLivenessRecord> {
    const key = livenessKey(input.workspaceId, input.deviceId);
    const existing = this.deviceLiveness.get(key);
    const record: DeviceCaptureLivenessRecord = {
      deviceId: input.deviceId,
      desiredState: input.desiredState,
      lastAliveAt: input.lastAliveAt,
      updatedAt: input.now,
      workspaceId: input.workspaceId,
    };
    this.deviceLiveness.set(key, { ...record, openCoverage: existing?.openCoverage });
    return { ...record };
  }

  private closeOpenSegment(
    workspaceId: string,
    deviceId: string,
    endedAt: string,
    closeReason: CaptureCoverageSegmentRecord['closeReason'],
    now: string,
  ): CaptureCoverageSegmentRecord | null {
    const key = livenessKey(workspaceId, deviceId);
    const existing = this.deviceLiveness.get(key);
    if (!existing?.openCoverage) return null;

    const record: CaptureCoverageSegmentRecord = {
      closeReason,
      coverageState: existing.openCoverage.coverageState,
      createdAt: now,
      deviceId,
      endedAt,
      id: randomUUID(),
      intervalMs: existing.openCoverage.intervalMs,
      startedAt: existing.openCoverage.startedAt,
      syncState: 'pending',
      tickCount: existing.openCoverage.tickCount,
      workspaceId,
    };
    this.coverageSegments.set(record.id, record);
    this.deviceLiveness.set(key, { ...existing, openCoverage: undefined, updatedAt: now });
    return { ...record };
  }

  async getBackpressureSnapshot(): Promise<OperationalStoreSnapshot> {
    const jobs = [...this.outboxJobs.values()];
    const assetBytes = [...this.assetRefs.values()]
      .filter((asset) => asset.cleanupState !== 'cleaned')
      .reduce((total, asset) => total + asset.sizeBytes, 0);

    return {
      assetBytes,
      queuedJobs: jobs.filter((job) => !isTerminalOutboxState(job.state)).length,
      retryingJobs: jobs.filter((job) => job.state === 'pending' && job.nextRetryAt !== undefined)
        .length,
    };
  }

  async getOutboxSummary(input: {
    minuteAgo: string;
    now: string;
    workspaceId: string;
  }): Promise<OutboxQueueSummary> {
    const minuteAgo = Date.parse(input.minuteAgo);
    const now = Date.parse(input.now);
    const summary: OutboxQueueSummary = {
      blocked: 0,
      completedPerMinute: 0,
      failed: 0,
      inputPerMinute: 0,
      pending: 0,
      processing: 0,
      retrying: 0,
      syncing: 0,
    };

    for (const job of this.outboxJobs.values()) {
      if (job.workspaceId !== input.workspaceId) continue;

      if (job.state === 'blocked') summary.blocked += 1;
      if (job.state === 'failed') summary.failed += 1;
      if (job.state === 'pending') summary.pending += 1;
      if (job.state === 'pending' && job.nextRetryAt) summary.retrying += 1;
      if (job.state === 'syncing' || job.state === 'result_pending') {
        summary.processing += 1;
        summary.syncing += 1;
      }

      const createdAt = Date.parse(job.createdAt);
      if (Number.isFinite(createdAt) && createdAt >= minuteAgo && createdAt <= now) {
        summary.inputPerMinute += 1;
      }
      if (
        job.state === 'synced' &&
        Number.isFinite(Date.parse(job.updatedAt)) &&
        Date.parse(job.updatedAt) >= minuteAgo &&
        Date.parse(job.updatedAt) <= now
      ) {
        summary.completedPerMinute += 1;
      }
      if (
        (job.state === 'pending' || job.state === 'syncing' || job.state === 'result_pending') &&
        Number.isFinite(createdAt) &&
        (!summary.oldestActiveCreatedAt || job.createdAt < summary.oldestActiveCreatedAt)
      ) {
        summary.oldestActiveCreatedAt = job.createdAt;
      }
      if (
        job.state === 'pending' &&
        job.nextRetryAt &&
        (!summary.nextRetryAt || job.nextRetryAt < summary.nextRetryAt)
      ) {
        summary.nextRetryAt = job.nextRetryAt;
      }
      if (job.lastSafeError) {
        summary.lastSafeError = { ...job.lastSafeError };
      }
    }

    return summary;
  }

  verifyOperationalWrite(): Promise<void> {
    return Promise.resolve();
  }

  async clearWorkspaceCache(workspaceId: string): Promise<void> {
    deleteMatching(this.outboxJobs, (job) => job.workspaceId === workspaceId);
    deleteMatching(this.assetRefs, (asset) => asset.workspaceId === workspaceId);
    deleteMatching(this.policyCache, (entry) => entry.workspaceId === workspaceId);
    deleteMatching(this.syncCursors, (cursor) => cursor.workspaceId === workspaceId);
    this.settingsCache.delete(workspaceId);
    deleteMatching(this.coverageSegments, (segment) => segment.workspaceId === workspaceId);
    deleteMatching(this.deviceLiveness, (liveness) => liveness.workspaceId === workspaceId);
  }

  async clearSignOutCache(): Promise<void> {
    this.outboxJobs.clear();
    this.assetRefs.clear();
    this.policyCache.clear();
    this.syncCursors.clear();
    this.settingsCache.clear();
    this.coverageSegments.clear();
    this.deviceLiveness.clear();
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

function compareOutboxJobs(left: OutboxJob, right: OutboxJob): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function groupActiveAssetDependencies(
  jobs: Iterable<OutboxJob>,
  workspaceId?: string,
): Map<string, OutboxJob[]> {
  const jobsByAssetRef = new Map<string, OutboxJob[]>();

  for (const job of jobs) {
    if ((workspaceId && job.workspaceId !== workspaceId) || !requiresLocalAssetBytes(job)) {
      continue;
    }

    const dependencies = jobsByAssetRef.get(job.assetRefId) ?? [];
    dependencies.push(job);
    jobsByAssetRef.set(job.assetRefId, dependencies);
  }

  return jobsByAssetRef;
}

function isTerminalOutboxState(state: OutboxJobState): state is OutboxTerminalState {
  return TERMINAL_OUTBOX_STATES.has(state);
}

function terminalTransitionConflict(): OperationalStoreError {
  return {
    code: 'terminal_state_conflict',
    message: 'Terminal outbox jobs cannot transition to another state.',
  };
}

const OUTBOX_LEASE_DURATION_MS = 60_000;

function leaseMatches(job: OutboxJob, expectedLeaseToken: string | undefined) {
  return job.leaseToken ? job.leaseToken === expectedLeaseToken : expectedLeaseToken === undefined;
}

function leaseLost(): OperationalStoreError {
  return {
    code: 'outbox_lease_lost',
    message: 'Outbox job lease is no longer held by this worker.',
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

function existingCaptureOutboxEntryMatches(
  existingJob: OutboxJob,
  entry: CaptureOutboxEntryCreateInput,
  assetRefs: Map<string, AssetCacheRef>,
): boolean {
  if (
    existingJob.assetRefId !== entry.assetRefId ||
    existingJob.payloadHash !== entry.payloadHash ||
    !capturePayloadMatches(existingJob.capture, normalizeCapturePayload(entry))
  ) {
    return false;
  }

  return entry.assetRefs.every((assetRef) => {
    const existingAssetRef = assetRefs.get(assetRef.assetRefId);
    return existingAssetRef ? assetRefMatches(existingAssetRef, assetRef) : false;
  });
}

function compareLocalCapturePolicyRules(
  left: LocalCapturePolicyRule,
  right: LocalCapturePolicyRule,
): number {
  return left.pattern.localeCompare(right.pattern) || left.id.localeCompare(right.id);
}

function policyCacheKey(workspaceId: string, deviceId: string): string {
  return `${workspaceId}:${deviceId}`;
}

function livenessKey(workspaceId: string, deviceId: string): string {
  return `${workspaceId}:${deviceId}`;
}
