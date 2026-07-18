import { randomUUID } from 'node:crypto';
import type {
  AssetCacheRef,
  CaptureOutboxEntryCreateInput,
  ClaimRetryableOutboxJobInput,
  HelperRuntimeState,
  LocalCapturePolicyRule,
  OperationalStoreError,
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
  RecoverInterruptedOutboxJobInput,
  SettingsCache,
  SyncCursor,
  SyncCursorKind,
  UpdateAssetRefAvailabilityInput,
} from './types';

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
  private helperState: HelperRuntimeState | null = null;

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

    const created: OutboxJob = {
      assetRefId: job.assetRefId,
      attempt: 0,
      capture: normalizeCapturePayload(job),
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

  async createCaptureOutboxEntry(
    entry: CaptureOutboxEntryCreateInput,
  ): Promise<OperationalStoreResult<OutboxJob>> {
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

    const created: OutboxJob = {
      assetRefId: entry.assetRefId,
      attempt: 0,
      capture: normalizeCapturePayload(entry),
      createdAt: entry.createdAt,
      deviceId: entry.deviceId,
      id: entry.id,
      idempotencyKey: entry.idempotencyKey,
      payloadHash: entry.payloadHash,
      state: 'pending',
      updatedAt: entry.createdAt,
      workspaceId: entry.workspaceId,
      ...(entry.nextRetryAt ? { nextRetryAt: entry.nextRetryAt } : {}),
    };

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
      ...(update.ocrResult ? { ocrResult: update.ocrResult } : {}),
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
    deleteMatching(this.policyCache, (entry) => entry.workspaceId === workspaceId);
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

function cloneOutboxJob(job: OutboxJob): OutboxJob {
  return {
    ...job,
    capture: cloneCapturePayload(job.capture),
    ...(job.lastSafeError ? { lastSafeError: { ...job.lastSafeError } } : {}),
  };
}

function normalizeCapturePayload(job: OutboxJobCreateInput): OutboxJob['capture'] {
  return {
    appName: job.capture?.appName ?? 'Recapsy Desktop',
    capturedAt: job.capture?.capturedAt ?? job.createdAt,
    captureType: job.capture?.captureType ?? 'screen',
    observedAt: job.capture?.observedAt ?? job.createdAt,
    privacyDecision: {
      action: job.capture?.privacyDecision?.action ?? 'allow',
      decidedAt:
        job.capture?.privacyDecision?.decidedAt ??
        job.capture?.observedAt ??
        job.capture?.capturedAt ??
        job.createdAt,
      policyVersion: job.capture?.privacyDecision?.policyVersion ?? 'desktop-default',
      reasons: [...(job.capture?.privacyDecision?.reasons ?? [])],
    },
    ...(job.capture?.bundleId ? { bundleId: job.capture.bundleId } : {}),
    ...(job.capture?.contextConfidence ? { contextConfidence: job.capture.contextConfidence } : {}),
    ...(job.capture?.contextFingerprint
      ? { contextFingerprint: job.capture.contextFingerprint }
      : {}),
    ...(job.capture?.documentPathCandidate
      ? { documentPathCandidate: { ...job.capture.documentPathCandidate } }
      : {}),
    ...(job.capture?.localEventId ? { localEventId: job.capture.localEventId } : {}),
    ...(job.capture?.metadata ? { metadata: { ...job.capture.metadata } } : {}),
    ...(job.capture?.urlCandidate ? { urlCandidate: { ...job.capture.urlCandidate } } : {}),
    ...(job.capture?.userId ? { userId: job.capture.userId } : {}),
    ...(job.capture?.windowTitleCandidate
      ? { windowTitleCandidate: { ...job.capture.windowTitleCandidate } }
      : {}),
  };
}

function cloneCapturePayload(capture: OutboxJob['capture']): OutboxJob['capture'] {
  return {
    ...capture,
    privacyDecision: {
      ...capture.privacyDecision,
      reasons: [...capture.privacyDecision.reasons],
    },
    ...(capture.documentPathCandidate
      ? { documentPathCandidate: { ...capture.documentPathCandidate } }
      : {}),
    ...(capture.metadata ? { metadata: { ...capture.metadata } } : {}),
    ...(capture.urlCandidate ? { urlCandidate: { ...capture.urlCandidate } } : {}),
    ...(capture.windowTitleCandidate
      ? { windowTitleCandidate: { ...capture.windowTitleCandidate } }
      : {}),
  };
}

function cloneAssetRef(asset: AssetCacheRef): AssetCacheRef {
  return {
    ...asset,
    ...(asset.availabilitySafeError
      ? { availabilitySafeError: { ...asset.availabilitySafeError } }
      : {}),
  };
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

function capturePayloadMatches(left: OutboxJob['capture'], right: OutboxJob['capture']): boolean {
  return JSON.stringify(cloneCapturePayload(left)) === JSON.stringify(cloneCapturePayload(right));
}

function assetRefMatches(left: AssetCacheRef, right: AssetCacheRef): boolean {
  return JSON.stringify(cloneAssetRef(left)) === JSON.stringify(cloneAssetRef(right));
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
    policy: {
      ...entry.policy,
      rules: entry.policy.rules.map((rule) => ({ ...rule })),
    },
  };
}

function cloneLocalCapturePolicyRule(rule: LocalCapturePolicyRule): LocalCapturePolicyRule {
  return { ...rule };
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
