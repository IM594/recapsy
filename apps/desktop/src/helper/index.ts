export { createSafeCaptureResultPayload } from './capture-result';
export type { CaptureResultInput, UnsafeCaptureContextInput } from './capture-result';
export {
  HELPER_PROTOCOL_MAX_LINE_LENGTH,
  HelperNdjsonLineParser,
  decodeHelperEnvelopeLine,
  encodeHelperEnvelope,
  parseHelperNdjsonChunk,
} from './protocol/codec';
export { HELPER_PROTOCOL_VERSION } from './protocol/types';
export type {
  CaptureAssetPayload,
  CaptureAssetRole,
  CaptureResultPayload,
  CaptureSourcePayload,
  HelperCaptureIdentity,
  HelperCapturePolicy,
  HelperCapturePolicyAction,
  HelperCapturePolicyRule,
  HelperEnvelope,
  HelperMessageType,
  HelperProtocolError,
  HelperProtocolErrorCode,
  HelperProtocolResult,
  HelperProtocolVersion,
  HelperToMainEnvelope,
  HelperToMainPayloadByType,
  HelperToMainType,
  MainToHelperEnvelope,
  MainToHelperPayloadByType,
  MainToHelperType,
  SafeCaptureContextPayload,
} from './protocol/types';
export {
  isSafeCaptureId,
  validateHelperToMainEnvelope,
  validateMainToHelperEnvelope,
} from './protocol/validation';
export type { HelperEnvelopeValidator } from './protocol/validation';
export {
  HelperPolicyActivationError,
  HelperPermissionCommandError,
  HelperTransportError,
  createHelperProcessClient,
} from './process-client';
export type {
  HelperPermissionCommandErrorCode,
  HelperProcess,
  HelperProcessClientOptions,
  HelperTransportErrorCode,
  SpawnHelperProcess,
} from './process-client';
export type {
  CaptureHelperClient,
  CaptureHelperCommandClient,
  CaptureHelperState,
  CaptureHelperStatus,
  CaptureHelperTermination,
  CaptureHelperTransportEvent,
  CaptureHelperTransportObserver,
  HelperPermissionCommandOptions,
  HelperPermissionSnapshot,
} from './types';
