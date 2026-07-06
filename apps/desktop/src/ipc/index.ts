export {
  IPC_CHANNEL_REGISTRY,
  validateIpcRequest,
} from './contracts';
export type {
  IpcChannelDefinition,
  IpcChannelName,
  IpcNamespace,
  IpcPreloadMethodName,
  IpcRequestValidation,
  RequestValidationResult,
} from './contracts';
export { assertRendererSafeDto } from './dto';
export type {
  CaptureEventSummaryDto,
  CaptureStatusDto,
  DiagnosticsBundleDto,
  DiagnosticsLogEntryDto,
  OcrJobSummaryDto,
  RendererSafeDtoResult,
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
} from './dto';
export {
  IPC_ERROR_CODES,
  createIpcErrorEnvelope,
} from './errors';
export type {
  IpcError,
  IpcErrorCode,
  IpcErrorEnvelope,
  IpcRequestEnvelope,
  IpcResponseEnvelope,
  IpcSuccessEnvelope,
} from './errors';
export { buildPreloadAllowlist } from './preload';
export type {
  PreloadAllowlist,
  PreloadInvoke,
} from './preload';
