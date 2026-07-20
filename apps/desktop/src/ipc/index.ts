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
  CaptureStatusDto,
  LocalCapturePolicyRuleDto,
  LocalCapturePolicyRulesDto,
  PermissionStatusDto,
  PrivacySettingsOpenResultDto,
  RetentionPreviewDto,
  RendererSafeDtoResult,
  SyncQueueSummaryDto,
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
export { createRendererSafeSuccess, registerIpcHandlers } from './handlers';
export type {
  ElectronIpcMainLike,
  IpcHandler,
  IpcHandlerMap,
} from './handlers';
