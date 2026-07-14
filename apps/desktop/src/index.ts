export { parseDesktopConfig } from './config/config';
export type {
  DesktopConfig,
  DesktopConfigError,
  DesktopConfigErrorCode,
  DesktopConfigInput,
  DesktopConfigResult,
} from './config/config';
export {
  createSessionStartup,
  createInMemoryTokenStore,
  createMacOsKeychainTokenStore,
} from './auth/public';
export type {
  AuthTokenSet,
  KeychainSecretStore,
  MacOsKeychainTokenStoreOptions,
  SessionStartup,
  SessionStartupOptions,
  SessionWorkspaceResolution,
  TokenStore,
} from './auth/public';
export {
  IPC_CHANNEL_REGISTRY,
  IPC_ERROR_CODES,
  assertRendererSafeDto,
  buildPreloadAllowlist,
  createIpcErrorEnvelope,
  validateIpcRequest,
} from './ipc/public';
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
} from './ipc/public';
export {
  HELPER_PROTOCOL_VERSION,
  HelperNdjsonLineParser,
  decodeHelperEnvelopeLine,
  encodeHelperEnvelope,
  parseHelperNdjsonChunk,
} from './helper/public';
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
} from './helper/public';
export { createSafeCaptureResultPayload } from './helper/public';
export type { CaptureProjectionInput, UnsafeCaptureContextInput } from './helper/public';
export { createSpawnCaptureHelperClient } from './helper/public';
export type {
  SpawnCaptureHelperClientOptions,
  SpawnedHelperProcess,
  SpawnHelperProcessFn,
} from './helper/public';
export { createMockHelperController } from './helper/public';
export type {
  MockHelperCommandResult,
  MockHelperController,
  MockHelperEmitResult,
  MockHelperError,
  MockHelperExitReason,
  MockHelperSnapshot,
  MockHelperState,
} from './helper/public';
export { createCaptureHelperController } from './capture/public';
export type {
  CaptureHelperAssetRef,
  CaptureHelperClient,
  CaptureHelperController,
  CaptureHelperEvent,
  CaptureHelperStartOptions,
  CaptureHelperState,
  CaptureHelperStatus,
} from './capture/public';
export { createCaptureHelperEventHandler } from './capture/public';
export type {
  CaptureHelperCommandClient,
  CaptureHelperEventHandler,
  CaptureHelperEventHandlerOptions,
  CaptureHelperEventStatus,
} from './capture/public';
export { createCaptureLifecycle, createCaptureRuntime } from './capture/public';
export type {
  CaptureAssetReconciliation,
  CaptureLifecycle,
  CaptureLifecycleOptions,
  CaptureLifecycleSnapshot,
  CaptureLifecycleStatus,
  CaptureRuntime,
  CaptureRuntimeOptions,
  CaptureStartupRecovery,
  HelperLifecycle,
} from './capture/public';
export { ServerApiError, createServerApiClient } from './server-api/public';
export type {
  CaptureIngestInput,
  CaptureIngestResult,
  CapturePoliciesInput,
  CapturePoliciesResult,
  AxAllowlistResult,
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
  TimelineQueryInput,
} from './server-api/public';
export { createSyncQueueSummary, createSyncScheduler } from './sync/public';
export { createSyncRuntime } from './sync/public';
export type { SyncRuntime, SyncRuntimeOptions } from './sync/public';
export { reconcileAssetRefs } from './storage/public';
export type {
  AssetAvailabilityCheck,
  AssetAvailabilityResolver,
  AssetReconciliationOptions,
  AssetReconciliationSummary,
} from './storage/public';
export { recoverInterruptedOutboxJobs } from './sync/public';
export type { StartupRecoveryOptions, StartupRecoverySummary } from './sync/public';
export type {
  SyncAssetReader,
  SyncCancelResult,
  SyncClock,
  SyncRunResult,
  SyncRunStatus,
  SyncSchedulerOptions,
  SyncServerApi,
  SyncWorkspaceProvider,
} from './sync/public';
export {
  createInMemoryOperationalStore,
  createSqliteOperationalStore,
  evaluateOperationalStoreBackpressure,
  runSqliteOperationalStoreMigrations,
  toRendererSafeAssetRef,
} from './storage/public';
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
} from './storage/public';
