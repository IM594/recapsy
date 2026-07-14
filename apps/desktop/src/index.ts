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
} from './auth/public';
export type {
  AuthTokenSet,
  SecretStore,
  SecretTokenStoreOptions,
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
  HELPER_PROTOCOL_MAX_LINE_LENGTH,
  HELPER_PROTOCOL_VERSION,
  HelperNdjsonLineParser,
  decodeHelperEnvelopeLine,
  encodeHelperEnvelope,
  parseHelperNdjsonChunk,
  validateHelperToMainEnvelope,
  validateMainToHelperEnvelope,
} from './helper/public';
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
} from './helper/public';
export { createSafeCaptureResultPayload } from './helper/public';
export type { CaptureResultInput, UnsafeCaptureContextInput } from './helper/public';
export { createHelperProcessClient } from './helper/public';
export type {
  HelperProcess,
  HelperProcessClientOptions,
  SpawnHelperProcess,
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
} from './capture/public';
export { ServerApiError, createServerApiClient } from './server/public';
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
} from './server/public';
export {
  createSyncJobExecutor,
  createSyncQueueSummary,
  createSyncWorker,
} from './sync/public';
export { createSyncRuntime } from './sync/public';
export type { SyncRuntime, SyncRuntimeOptions } from './sync/public';
export { reconcileAssetRefs } from './storage/public';
export type {
  AssetAvailabilityCheck,
  AssetAvailabilityResolver,
  AssetReconciliationOptions,
  AssetReconciliationStore,
  AssetReconciliationSummary,
} from './storage/public';
export { recoverSyncQueue } from './sync/public';
export type { SyncRecoveryOptions, SyncRecoverySummary } from './sync/public';
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
} from './sync/public';
export {
  createMemoryStore,
  createSqliteStore,
  evaluateOperationalStoreBackpressure,
  migrateSqliteStore,
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
} from './storage/public';
