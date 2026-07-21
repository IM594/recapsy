import type {
  AiOcrUsage,
  CaptureCoverageState,
  CaptureDefaultPolicy,
  CapturePolicyRule,
  DeviceCaptureDesiredState,
  OcrQualityFlag,
  OcrScreenTextResult,
} from '@recapsy/contracts';

export type OutboxJobState =
  | 'pending'
  | 'syncing'
  | 'result_pending'
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

/**
 * OCR transcript retained locally after a successful proxy call so a failed
 * result submission can be retried without re-running (and re-billing) the
 * provider OCR. Persisted as `ocr_result_json`; carries the submission
 * metadata the ocr-result endpoint records (`model`/`providerName`/
 * `durationMs`/`usage`) plus `sourceAssetHash`, so a crash-recovered
 * `result_pending` job can resubmit self-sufficiently without another proxy
 * round-trip. See `docs/design/OCR_OUTBOX_STATE_MACHINE.md` §3.2.
 */
export type StoredOcrResult = {
  screenText: OcrScreenTextResult;
  sourceAssetHash: string;
  model: string;
  providerName: string;
  durationMs: number;
  usage?: AiOcrUsage;
  /** Real facts about this transcript's fidelity, derived at OCR time (see `sync/screen-text.ts`). */
  qualityFlags: OcrQualityFlag[];
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
  leaseToken?: string;
  leaseExpiresAt?: string;
  serverCaptureId?: string;
  ocrResult?: StoredOcrResult;
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

export type CaptureOutboxEntryCreateInput = OutboxJobCreateInput & {
  assetRefs: AssetCacheRef[];
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
  ocrResult?: StoredOcrResult;
  leaseToken?: string;
};

export type OutboxTerminalUpdate = {
  state: OutboxTerminalState;
  now: string;
  reason: string;
  serverCaptureId?: string;
  lastSafeError?: SafeOperationalError;
  leaseToken?: string;
};

export type OutboxSafeErrorInput = {
  code: string;
  message: string;
  retryable: boolean;
  retryAt?: string;
  now: string;
  maxAttempts: number;
  leaseToken?: string;
};

export type RecoverInterruptedOutboxJobInput = {
  id: string;
  now: string;
  nextRetryAt: string;
  lastSafeError: SafeOperationalError;
  leaseToken?: string;
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
export type AssetAvailabilityState = 'available' | 'missing' | 'unreadable';

export type AssetCacheRef = {
  assetRefId: string;
  workspaceId: string;
  role: AssetCacheRefRole;
  hash: string;
  mimeType: string;
  sizeBytes: number;
  cleanupState: AssetCleanupState;
  cleanupUpdatedAt?: string;
  cleanupSafeError?: SafeOperationalError;
  availabilityState: AssetAvailabilityState;
  availabilityCheckedAt?: string;
  availabilitySafeError?: SafeOperationalError;
  createdAt: string;
  localAccessKey: string;
  contentAddress?: string;
};

export type RendererSafeAssetRef = {
  assetRefId: string;
  role: AssetCacheRefRole;
  mimeType: string;
  sizeBytes: number;
  cleanupState: AssetCleanupState;
  availabilityState: AssetAvailabilityState;
  availabilityCheckedAt?: string;
  availabilitySafeError?: Pick<SafeOperationalError, 'code' | 'retryable'>;
  createdAt: string;
};

export type UpdateAssetRefAvailabilityInput = {
  assetRefId: string;
  availabilityState: AssetAvailabilityState;
  now: string;
  availabilitySafeError?: SafeOperationalError;
};

export type ClaimAssetCleanupInput = {
  assetRefId: string;
  now: string;
};

export type SetAssetCleanupStateInput = {
  assetRefId: string;
  cleanupState: Extract<AssetCleanupState, 'cleaned' | 'cleanup_failed'>;
  cleanupSafeError?: SafeOperationalError;
  now: string;
};

export type RecoverPendingAssetCleanupInput = {
  now: string;
  workspaceId: string;
};

export type HelperPermissionState = 'granted' | 'denied' | 'not_determined' | 'unknown';

export type PolicyCacheEntry = {
  workspaceId: string;
  deviceId: string;
  policySnapshotId: string;
  policyVersion: string;
  policy: CaptureDefaultPolicy;
  fetchedAt: string;
  ttlSeconds: number;
  maxConcurrentOcr?: number;
};

export type PolicyCacheRead = PolicyCacheEntry & {
  expired: boolean;
};

export type PolicyCacheReadOptions = {
  now: string;
};

/** Device-profile privacy rule. V0 intentionally supports one exact, locally
 * enforceable action so the UI cannot create a rule the native helper only
 * pretends to understand. */
export type LocalCapturePolicyRule = Omit<CapturePolicyRule, 'action' | 'kind' | 'scope'> & {
  action: 'block_capture';
  kind: 'bundle_id';
  scope: 'local_user';
  createdAt: string;
  updatedAt: string;
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
  | 'asset_ref_conflict'
  | 'asset_cleanup_conflict'
  | 'idempotency_key_conflict'
  | 'terminal_state_conflict'
  | 'outbox_lease_lost'
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

export type ServerCaptureSettlementInput = {
  id: string;
  leaseToken?: string;
  now: string;
  serverCaptureId: string;
};

export type ServerCaptureSettlement =
  | { status: 'synced' }
  | { status: 'skipped'; code?: 'lease_lost' };

/** Device-wide pressure from local resources shared by every workspace. */
export type OperationalStoreSnapshot = {
  queuedJobs: number;
  assetBytes: number;
  retryingJobs: number;
};

export type OutboxQueueSummary = {
  blocked: number;
  completedPerMinute: number;
  failed: number;
  inputPerMinute: number;
  pending: number;
  processing: number;
  retrying: number;
  syncing: number;
  lastSafeError?: SafeOperationalError;
  nextRetryAt?: string;
  oldestActiveCreatedAt?: string;
};

export type BackpressureConfig = {
  maxQueuedJobs: number;
  maxAssetBytes: number;
  maxRetryingJobs: number;
  resumeQueuedJobs: number;
  resumeAssetBytes: number;
  resumeRetryingJobs: number;
};

export type BackpressureReason =
  | 'max_queued_jobs_reached'
  | 'max_retrying_jobs_reached'
  | 'max_asset_bytes_reached';

export type BackpressureDecision = {
  action: 'allow' | 'pause';
  hardLimit: boolean;
  reasons: BackpressureReason[];
};

export type StoreLifecycle = {
  initialize(): Promise<void>;
  close(): void;
};

// Capture-coverage spine (local persistence). A device tracks at most one
// growing "open" run per (workspaceId, deviceId) at a time; its tail lives on
// the device's own liveness row (`open_coverage_*` columns) rather than as a
// row of its own, so a static hour costs one liveness row update per tick
// instead of a growing table. Only closed runs become rows in
// `capture_coverage_segments`, and only closed rows ever sync to the server
// (see `packages/contracts/src/schemas/coverage.ts`).
export type CoverageCloseReason =
  | 'frame_captured'
  | 'state_changed'
  | 'cadence_gap'
  | 'paused'
  | 'helper_exit'
  | 'inferred_on_recovery';

export type CaptureCoverageSegmentRecord = {
  id: string;
  workspaceId: string;
  deviceId: string;
  coverageState: CaptureCoverageState;
  startedAt: string;
  endedAt: string;
  tickCount: number;
  intervalMs: number;
  closeReason: CoverageCloseReason;
  syncState: 'pending' | 'synced';
  createdAt: string;
};

export type OpenCoverageSegmentInput = {
  workspaceId: string;
  deviceId: string;
  coverageState: CaptureCoverageState;
  startedAt: string;
  intervalMs: number;
  now: string;
};

export type ExtendOpenCoverageSegmentInput = {
  workspaceId: string;
  deviceId: string;
  tickCount: number;
  now: string;
};

export type CloseOpenCoverageSegmentInput = {
  workspaceId: string;
  deviceId: string;
  endedAt: string;
  closeReason: CoverageCloseReason;
  now: string;
};

export type OpenCoverageSegmentRecord = {
  coverageState: CaptureCoverageState;
  startedAt: string;
  tickCount: number;
  intervalMs: number;
};

export type DeviceCaptureLivenessRecord = {
  workspaceId: string;
  deviceId: string;
  lastAliveAt: string;
  desiredState: DeviceCaptureDesiredState;
  updatedAt: string;
};

export type UpsertDeviceCaptureLivenessInput = {
  workspaceId: string;
  deviceId: string;
  lastAliveAt: string;
  desiredState: DeviceCaptureDesiredState;
  now: string;
};

export type RecoverHangingCoverageSegmentInput = {
  workspaceId: string;
  deviceId: string;
  now: string;
};
