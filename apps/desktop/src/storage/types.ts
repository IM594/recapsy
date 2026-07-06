export type OutboxJobState =
  | 'pending'
  | 'uploading'
  | 'ocr_wait'
  | 'synced'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export type OutboxTerminalState = Extract<
  OutboxJobState,
  'synced' | 'blocked' | 'failed' | 'cancelled'
>;

export type SafeOperationalError = {
  code: string;
  message: string;
  retryable: boolean;
};

export type OutboxJob = {
  id: string;
  workspaceId: string;
  deviceId: string;
  assetRefId: string;
  idempotencyKey: string;
  payloadHash: string;
  capture: CaptureOutboxPayload;
  state: OutboxJobState;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  nextRetryAt?: string;
  lockedAt?: string;
  serverCaptureId?: string;
  serverOcrJobId?: string;
  lastSafeError?: SafeOperationalError;
  terminalReason?: string;
};

export type OutboxJobCreateInput = {
  id: string;
  workspaceId: string;
  deviceId: string;
  assetRefId: string;
  idempotencyKey: string;
  payloadHash: string;
  capture?: CaptureOutboxPayloadInput;
  createdAt: string;
  nextRetryAt?: string;
};

export type CapturePrivacyDecision = {
  action: 'allow' | 'block_capture' | 'redact_context' | 'block_ocr';
  decidedAt: string;
  policyVersion: string;
  reasons: string[];
};

export type CaptureOutboxPayload = {
  capturedAt: string;
  observedAt: string;
  appName: string;
  captureType: 'screen' | 'window';
  privacyDecision: CapturePrivacyDecision;
  localEventId?: string;
  userId?: string;
  bundleId?: string;
  windowTitleCandidate?: {
    kind: 'safe' | 'redacted' | 'omitted';
    value?: string;
    reason?: string;
  };
  urlCandidate?: {
    kind: 'safe' | 'redacted' | 'omitted';
    normalized?: string;
    domain?: string;
    hash?: string;
    reason?: string;
  };
  documentPathCandidate?: {
    kind: 'safe' | 'redacted' | 'omitted';
    displayName?: string;
    hash?: string;
    reason?: string;
  };
  contextFingerprint?: string;
  contextConfidence?: 'high' | 'medium' | 'low' | 'unknown';
  metadata?: Record<string, unknown>;
};

export type CaptureOutboxPayloadInput = Partial<Omit<CaptureOutboxPayload, 'privacyDecision'>> & {
  privacyDecision?: Partial<CapturePrivacyDecision>;
};

export type OutboxJobStateUpdate = {
  state: OutboxJobState;
  now: string;
  nextRetryAt?: string;
  serverCaptureId?: string;
  serverOcrJobId?: string;
};

export type OutboxTerminalUpdate = {
  state: OutboxTerminalState;
  now: string;
  reason: string;
  serverCaptureId?: string;
  serverOcrJobId?: string;
};

export type OutboxSafeErrorInput = {
  code: string;
  message: string;
  retryable: boolean;
  retryAt?: string;
  now: string;
  maxAttempts: number;
};

export type ClaimRetryableOutboxJobInput = {
  workspaceId: string;
  now: string;
  maxAttempts: number;
};

export type OutboxJobListFilter = {
  workspaceId?: string;
  state?: OutboxJobState;
};

export type AssetCacheRefRole =
  | 'capture_original'
  | 'capture_thumbnail'
  | 'ocr_input'
  | 'derived_asset';

export type AssetCleanupState = 'retained' | 'cleanup_pending' | 'cleaned' | 'cleanup_failed';

export type AssetCacheRef = {
  assetRefId: string;
  workspaceId: string;
  role: AssetCacheRefRole;
  hash: string;
  mimeType: string;
  sizeBytes: number;
  cleanupState: AssetCleanupState;
  createdAt: string;
  localAccessKey: string;
  contentAddress?: string;
};

export type RendererSafeAssetRef = Omit<
  AssetCacheRef,
  'workspaceId' | 'localAccessKey' | 'contentAddress'
>;

export type HelperPermissionState = 'granted' | 'denied' | 'not_determined' | 'unknown';

export type HelperRuntimeState = {
  helperVersion?: string;
  transport: 'stdio_ndjson';
  pidDigest?: string;
  permissions: {
    screenRecording: HelperPermissionState;
    accessibility: HelperPermissionState;
  };
  lastHeartbeatAt?: string;
  restartCount: number;
  lastSafeError?: SafeOperationalError;
  updatedAt: string;
};

export type PolicyAction = 'block_capture' | 'redact_context' | 'block_ocr';

export type PolicyCacheEntry = {
  workspaceId: string;
  policyVersion: string;
  actions: PolicyAction[];
  fetchedAt: string;
  ttlSeconds: number;
};

export type PolicyCacheRead = PolicyCacheEntry & {
  expired: boolean;
};

export type PolicyCacheReadOptions = {
  now: string;
};

export type SyncCursorKind = 'timeline' | 'search' | 'settings' | 'capabilities';

export type SyncCursor = {
  workspaceId: string;
  kind: SyncCursorKind;
  cursor: string;
  etag?: string;
  updatedAt: string;
};

export type SettingsCache = {
  workspaceId: string;
  deviceId: string;
  captureEnabled: boolean;
  fetchedAt: string;
  serverCapabilities: {
    sync: boolean;
    ocr: boolean;
    timeline: boolean;
    search: boolean;
  };
};

export type OperationalStoreErrorCode =
  | 'outbox_job_not_found'
  | 'asset_ref_not_found'
  | 'outbox_job_id_conflict'
  | 'idempotency_key_conflict'
  | 'terminal_state_conflict'
  | 'storage_corruption'
  | 'capacity_exceeded';

export type OperationalStoreError = {
  code: OperationalStoreErrorCode;
  message: string;
};

export type OperationalStoreResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: OperationalStoreError;
    };

export type OperationalStoreSnapshot = {
  queuedJobs: number;
  assetBytes: number;
  maxAttempt: number;
};

export type BackpressureConfig = {
  maxQueuedJobs: number;
  maxAssetBytes: number;
  maxRetryAttempts: number;
};

export type BackpressureReason =
  | 'max_queued_jobs_reached'
  | 'max_asset_bytes_reached'
  | 'max_retry_attempts_reached';

export type BackpressureDecision = {
  action: 'allow' | 'pause';
  hardLimit: boolean;
  reasons: BackpressureReason[];
};

export type OperationalStoreRepository = {
  createOutboxJob(job: OutboxJobCreateInput): Promise<OperationalStoreResult<OutboxJob>>;
  getOutboxJob(id: string): Promise<OutboxJob | null>;
  listOutboxJobs(filter?: OutboxJobListFilter): Promise<OutboxJob[]>;
  updateOutboxJobState(
    id: string,
    update: OutboxJobStateUpdate,
  ): Promise<OperationalStoreResult<OutboxJob>>;
  claimNextRetryableOutboxJob(input: ClaimRetryableOutboxJobInput): Promise<OutboxJob | null>;
  markOutboxJobTerminal(
    id: string,
    update: OutboxTerminalUpdate,
  ): Promise<OperationalStoreResult<OutboxJob>>;
  recordOutboxSafeError(
    id: string,
    input: OutboxSafeErrorInput,
  ): Promise<OperationalStoreResult<OutboxJob>>;
  upsertAssetCacheRef(asset: AssetCacheRef): Promise<AssetCacheRef>;
  getAssetCacheRef(assetRefId: string): Promise<AssetCacheRef | null>;
  listAssetCacheRefs(workspaceId: string): Promise<AssetCacheRef[]>;
  deleteAssetCacheRef(assetRefId: string): Promise<boolean>;
  setHelperState(state: HelperRuntimeState): Promise<HelperRuntimeState>;
  getHelperState(): Promise<HelperRuntimeState | null>;
  setPolicyCache(entry: PolicyCacheEntry): Promise<PolicyCacheEntry>;
  getPolicyCache(
    workspaceId: string,
    options: PolicyCacheReadOptions,
  ): Promise<PolicyCacheRead | null>;
  setSyncCursor(cursor: SyncCursor): Promise<SyncCursor>;
  getSyncCursor(workspaceId: string, kind: SyncCursorKind): Promise<SyncCursor | null>;
  setSettingsCache(settings: SettingsCache): Promise<SettingsCache>;
  getSettingsCache(workspaceId: string): Promise<SettingsCache | null>;
  getBackpressureSnapshot(workspaceId: string): Promise<OperationalStoreSnapshot>;
  clearWorkspaceCache(workspaceId: string): Promise<void>;
  clearSignOutCache(): Promise<void>;
};
