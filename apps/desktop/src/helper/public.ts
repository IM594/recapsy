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
  HELPER_PROTOCOL_VERSION,
  HelperNdjsonLineParser,
  decodeHelperEnvelopeLine,
  encodeHelperEnvelope,
  parseHelperNdjsonChunk,
} from './protocol';
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
} from './protocol';
export { createSpawnCaptureHelperClient } from './spawn-capture-helper-client';
export type {
  SpawnCaptureHelperClientOptions,
  SpawnedHelperProcess,
  SpawnHelperProcessFn,
} from './spawn-capture-helper-client';
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
