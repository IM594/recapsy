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
  createSecretTokenStore,
} from './auth/index';
export type {
  AuthTokenSet,
  SecretStore,
  SecretTokenStoreOptions,
  SessionStartup,
  SessionStartupOptions,
  SessionWorkspaceResolution,
  TokenStore,
} from './auth/index';
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
  HELPER_PROTOCOL_MAX_LINE_LENGTH,
  HELPER_PROTOCOL_VERSION,
  HelperNdjsonLineParser,
  decodeHelperEnvelopeLine,
  encodeHelperEnvelope,
  parseHelperNdjsonChunk,
  validateHelperToMainEnvelope,
  validateMainToHelperEnvelope,
} from './helper/index';
export type {
  CaptureAssetPayload,
  CaptureAssetRole,
  CaptureResultPayload,
  HelperEnvelope,
  HelperEnvelopeValidator,
  HelperMessageType,
  HelperProtocolError,
  HelperProtocolErrorCode,
  HelperProtocolResult,
  HelperProtocolVersion,
  HelperToMainEnvelope,
  HelperToMainPayloadByType,
  HelperToMainType,
  MainToHelperPayloadByType,
  MainToHelperEnvelope,
  MainToHelperType,
  SafeCaptureContextPayload,
} from './helper/index';
export { createSafeCaptureResultPayload } from './helper/index';
export type { CaptureResultInput, UnsafeCaptureContextInput } from './helper/index';
export { createHelperProcessClient } from './helper/index';
export type {
  HelperProcess,
  HelperProcessClientOptions,
  SpawnHelperProcess,
} from './helper/index';
export { createMockHelperController } from './helper/index';
export type {
  MockHelperCommandResult,
  MockHelperController,
  MockHelperEmitResult,
  MockHelperError,
  MockHelperExitReason,
  MockHelperSnapshot,
  MockHelperState,
} from './helper/index';
export { createCaptureHelperController } from './capture/index';
export type {
  CaptureHelperAssetRef,
  CaptureHelperClient,
  CaptureHelperController,
  CaptureHelperEvent,
  CaptureHelperStartOptions,
  CaptureHelperState,
  CaptureHelperStatus,
} from './capture/index';
export { createCaptureHelperEventHandler } from './capture/index';
export type {
  CaptureHelperCommandClient,
  CaptureHelperEventHandler,
  CaptureHelperEventHandlerOptions,
  CaptureHelperEventStatus,
} from './capture/index';
export { createCaptureLifecycle, createCaptureRuntime } from './capture/index';
export type {
  CaptureAssetReconciliation,
  CaptureHistoryReader,
  CaptureIntakeStore,
  CaptureLifecycle,
  CaptureLifecycleOptions,
  CaptureLifecycleSnapshot,
  CaptureLifecycleStatus,
  CaptureRuntime,
  CaptureRuntimeOptions,
  CaptureRuntimeStore,
  CaptureStartupRecovery,
  HelperStateStore,
  HelperLifecycle,
} from './capture/index';
export { ServerApiError, createServerApiClient } from './server/index';
export type {
  CaptureCreateInput,
  CaptureCreateResult,
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
} from './server/index';
export {
  createSyncJobExecutor,
  createSyncQueueSummary,
  createSyncWorker,
} from './sync/index';
export { createSyncRuntime } from './sync/index';
export type { SyncRuntime, SyncRuntimeOptions } from './sync/index';
export { reconcileAssetRefs } from './storage/index';
export type {
  AssetAvailabilityCheck,
  AssetAvailabilityResolver,
  AssetReconciliationOptions,
  AssetReconciliationStore,
  AssetReconciliationSummary,
} from './storage/index';
export { recoverSyncQueue } from './sync/index';
export type { SyncRecoveryOptions, SyncRecoverySummary } from './sync/index';
export type {
  SyncJobApi,
  SyncJobExecutor,
  SyncJobExecutorOptions,
  SyncJobStore,
  SyncAssetReader,
  SyncCancelResult,
  SyncClock,
  SyncRunResult,
  SyncRunStatus,
  SyncWorkerOptions,
  SyncServerApi,
  SyncWorkspaceProvider,
} from './sync/index';
export {
  createMemoryStore,
  createSqliteStore,
  evaluateOperationalStoreBackpressure,
  migrateSqliteStore,
  toRendererSafeAssetRef,
} from './storage/index';
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
  StoreLifecycle,
  SqliteDatabase,
  SqliteStoreOptions,
  SqliteParameters,
  SqliteRow,
  SqliteRunResult,
  SqliteStatement,
  SqliteValue,
  SyncCursor,
  SyncCursorKind,
  UpdateAssetRefAvailabilityInput,
} from './storage/index';
