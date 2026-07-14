export { createMockHelperController } from './mock-controller';
export type {
  MockHelperCommandResult,
  MockHelperController,
  MockHelperEmitResult,
  MockHelperError,
  MockHelperExitReason,
  MockHelperSnapshot,
  MockHelperState,
} from './mock-controller';
export { createSafeCaptureResultPayload } from './projection';
export type { CaptureProjectionInput, UnsafeCaptureContextInput } from './projection';
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
  validateHelperToMainEnvelope,
  validateMainToHelperEnvelope,
} from './protocol/validation';
export type { HelperEnvelopeValidator } from './protocol/validation';
export { createHelperProcessClient } from './process-client';
export type {
  HelperProcess,
  HelperProcessClientOptions,
  SpawnHelperProcess,
} from './process-client';
export type {
  CaptureHelperAssetRef,
  CaptureHelperClient,
  CaptureHelperCommandClient,
  CaptureHelperEvent,
  CaptureHelperStartOptions,
  CaptureHelperState,
  CaptureHelperStatus,
  HelperLifecycle,
} from './types';
