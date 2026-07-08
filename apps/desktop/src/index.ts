export { parseDesktopConfig } from './config/config';
export type {
  DesktopConfig,
  DesktopConfigError,
  DesktopConfigErrorCode,
  DesktopConfigInput,
  DesktopConfigResult,
} from './config/config';
export {
  createInMemoryTokenStore,
  createMacOsKeychainTokenStore,
} from './auth/token-store';
export type {
  AuthTokenSet,
  KeychainSecretStore,
  MacOsKeychainTokenStoreOptions,
  TokenStore,
} from './auth/token-store';
export {
  IPC_CHANNEL_REGISTRY,
  IPC_ERROR_CODES,
  assertRendererSafeDto,
  buildPreloadAllowlist,
  createIpcErrorEnvelope,
  validateIpcRequest,
} from './ipc/index';
export type {
  CaptureEventSummaryDto,
  CaptureStatusDto,
  DiagnosticsBundleDto,
  DiagnosticsLogEntryDto,
  IpcChannelDefinition,
  IpcChannelName,
  IpcError,
  IpcErrorCode,
  IpcErrorEnvelope,
  IpcNamespace,
  IpcPreloadMethodName,
  IpcRequestEnvelope,
  IpcRequestValidation,
  IpcResponseEnvelope,
  IpcSuccessEnvelope,
  OcrJobSummaryDto,
  PreloadAllowlist,
  PreloadInvoke,
  RendererSafeDtoResult,
  RequestValidationResult,
  RuntimeStatusDto,
  SafeSessionSummary,
  SearchQueryRequestDto,
  SearchQueryResponseDto,
  SearchResultDto,
  SettingsRuntimeDto,
  SyncQueueSummaryDto,
  TimelineItemDto,
  TimelineQueryRequestDto,
  TimelineQueryResponseDto,
  WorkspaceCapabilitiesDto,
  WorkspaceSummaryDto,
} from './ipc/index';
export {
  HELPER_PROTOCOL_VERSION,
  HelperNdjsonLineParser,
  decodeHelperEnvelopeLine,
  encodeHelperEnvelope,
  parseHelperNdjsonChunk,
} from './helper/protocol';
export type {
  CaptureAssetPayload,
  CaptureAssetRole,
  CaptureResultPayload,
  HelperEnvelope,
  HelperMessageType,
  HelperProtocolError,
  HelperProtocolErrorCode,
  HelperProtocolResult,
  HelperProtocolVersion,
  HelperToMainPayloadByType,
  HelperToMainType,
  MainToHelperPayloadByType,
  MainToHelperType,
  SafeCaptureContextPayload,
} from './helper/protocol';
export { createSafeCaptureResultPayload } from './helper/projection';
export type { CaptureProjectionInput, UnsafeCaptureContextInput } from './helper/projection';
export { createSpawnCaptureHelperClient } from './helper/spawn-capture-helper-client';
export type {
  SpawnCaptureHelperClientOptions,
  SpawnedHelperProcess,
  SpawnHelperProcessFn,
} from './helper/spawn-capture-helper-client';
export { createMockHelperController } from './helper/mock-controller';
export type {
  MockHelperCommandResult,
  MockHelperController,
  MockHelperEmitResult,
  MockHelperError,
  MockHelperExitReason,
  MockHelperSnapshot,
  MockHelperState,
} from './helper/mock-controller';
export { createCaptureHelperController } from './runtime/capture-helper-controller';
export type {
  CaptureHelperAssetRef,
  CaptureHelperClient,
  CaptureHelperController,
  CaptureHelperEvent,
  CaptureHelperStartOptions,
  CaptureHelperState,
  CaptureHelperStatus,
} from './runtime/capture-helper-controller';
export { createCaptureHelperEventIntake } from './runtime/capture-helper-event-intake';
export type {
  CaptureHelperCommandClient,
  CaptureHelperEventIntake,
  CaptureHelperEventIntakeOptions,
  CaptureHelperEventIntakeStatus,
} from './runtime/capture-helper-event-intake';
export { createDesktopRuntime } from './runtime/lifecycle-controller';
export type {
  DesktopRuntime,
  HelperLifecycle,
  RuntimeSnapshot,
  RuntimeStatus,
} from './runtime/types';
export type {
  AssetReconciliationLifecycle as DesktopAssetReconciliationLifecycle,
  StartupRecoveryLifecycle,
} from './runtime/lifecycle-controller';
export { ServerApiError, createServerApiClient } from './server-api/client';
export type {
  CaptureIngestInput,
  CaptureIngestResult,
  CapturePoliciesInput,
  CapturePoliciesResult,
  AxAllowlistResult,
  OcrJobCancelResult,
  OcrJobCreateInput,
  OcrJobCreateResult,
  OcrJobSafeError,
  OcrJobSafeErrorCode,
  OcrJobStatus,
  OcrJobStatusResult,
  SearchQueryInput,
  ServerApiClient,
  ServerApiClientOptions,
  ServerCapabilitiesResult,
  ServerCapabilityFeature,
  ServerApiErrorCode,
  ServerApiErrorShape,
  ServerApiTransport,
  ServerApiTransportRequest,
  ServerApiTransportResponse,
  ServerProviderCapability,
  TemporaryByteUploadInput,
  TemporaryByteUploadResult,
  TemporaryUploadInput,
  TemporaryUploadResult,
  TimelineQueryInput,
} from './server-api/client';
export { createSyncQueueSummary, createSyncScheduler } from './sync/scheduler';
export { reconcileAssetRefs } from './storage/asset-reconciliation';
export type {
  AssetAvailabilityCheck,
  AssetAvailabilityResolver,
  AssetReconciliationOptions,
  AssetReconciliationSummary,
} from './storage/asset-reconciliation';
export { recoverInterruptedOutboxJobs } from './sync/startup-recovery';
export type { StartupRecoveryOptions, StartupRecoverySummary } from './sync/startup-recovery';
export type {
  SyncAssetReader,
  SyncCancelResult,
  SyncClock,
  SyncRunResult,
  SyncRunStatus,
  SyncSchedulerOptions,
  SyncServerApi,
  SyncWorkspaceProvider,
} from './sync/types';
export {
  createInMemoryOperationalStore,
  createSqliteOperationalStore,
  evaluateOperationalStoreBackpressure,
  runSqliteOperationalStoreMigrations,
  toRendererSafeAssetRef,
} from './storage';
export type {
  AssetCacheRef,
  AssetCacheRefRole,
  AssetAvailabilityState,
  AssetCleanupState,
  BackpressureConfig,
  BackpressureDecision,
  BackpressureReason,
  CaptureOutboxPayload,
  CaptureOutboxPayloadInput,
  CapturePrivacyDecision,
  ClaimRetryableOutboxJobInput,
  HelperPermissionState,
  HelperRuntimeState,
  OperationalStoreError,
  OperationalStoreErrorCode,
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
  PolicyAction,
  PolicyCacheEntry,
  PolicyCacheRead,
  PolicyCacheReadOptions,
  RecoverInterruptedOutboxJobInput,
  RendererSafeAssetRef,
  SafeOperationalError,
  SettingsCache,
  SqliteDatabase,
  SqliteOperationalStoreOptions,
  SqliteParameters,
  SqliteRow,
  SqliteRunResult,
  SqliteStatement,
  SqliteValue,
  SyncCursor,
  SyncCursorKind,
  UpdateAssetRefAvailabilityInput,
} from './storage';
