export const HELPER_PROTOCOL_VERSION = 'recapsy.capture-helper' as const;

export type HelperProtocolVersion = typeof HELPER_PROTOCOL_VERSION;

export type HelperProtocolErrorCode =
  | 'invalid_json'
  | 'schema_mismatch'
  | 'unsupported_protocol_version'
  | 'unknown_message_type';

export type HelperProtocolError = {
  code: HelperProtocolErrorCode;
  message: string;
  captureId?: string;
  correlationId?: string | null;
  messageId?: string;
  messageType?: string;
};

export type HelperProtocolResult<T> =
  | { ok: true; envelope: T }
  | { ok: false; error: HelperProtocolError };

export type CaptureAssetRole = 'screenshot' | 'thumbnail' | 'manifest';

export type CaptureAssetPayload = {
  role: CaptureAssetRole;
  ref: string;
  hash: string;
  mimeType: string;
  sizeBytes: number;
};

export type SafeCaptureContextPayload = {
  observedAt: string;
  app?: { name: string; bundleId: string };
  window?: { title: string };
  website?: { origin: string; host: string };
  document?: { name: string };
  policy: {
    version: string;
    decision: 'allow' | 'redact_context' | 'block_ocr';
  };
};

export type CaptureResultPayload = {
  captureId: string;
  observedAt: string;
  manifest: CaptureAssetPayload;
  assets: CaptureAssetPayload[];
  context: SafeCaptureContextPayload;
};

export type HelperToMainPayloadByType = {
  'helper.hello': {
    helperVersion: string;
    pid: number | null;
    capabilities: { capture: boolean; permissions: boolean; mock: boolean };
  };
  'helper.status': {
    status: 'starting' | 'ready' | 'paused' | 'stopping' | 'stopped' | 'error';
    reason?: string;
  };
  'permission.status': {
    screenCapture: 'granted' | 'denied' | 'not_determined' | 'unknown';
    accessibility: 'granted' | 'denied' | 'not_determined' | 'unknown';
    observedAt: string;
  };
  'capture.result': CaptureResultPayload;
  'capture.skipped': {
    captureId: string;
    reason: 'paused' | 'policy_denied' | 'duplicate' | 'blank' | 'secure_input' | 'private_context';
    observedAt: string;
  };
  'capture.error': {
    captureId?: string;
    code:
      | 'capture_failed'
      | 'permission_missing'
      | 'permission_revoked'
      | 'asset_write_failed'
      | 'helper_unavailable'
      | 'unknown';
    message: string;
  };
  'helper.heartbeat': {
    sequence: number;
    status: 'starting' | 'ready' | 'paused' | 'stopping';
  };
  'helper.exiting': {
    reason: 'shutdown_requested' | 'quit_requested' | 'process_crashed' | 'unknown';
    code: number | null;
  };
};

export type MainToHelperPayloadByType = {
  'helper.configure': { captureIntervalMs?: number; policyVersion: string };
  'permission.refresh': Record<string, never>;
  'capture.start': { reason: 'runtime_started' | 'user_resumed' };
  'capture.pause': {
    reason: 'user_paused' | 'backpressure' | 'permission_missing' | 'runtime_stopping';
  };
  'capture.resume': { reason: 'user_resumed' | 'backpressure_relieved' };
  'capture.flush': { reason: 'shutdown' | 'manual' };
  'capture.ack': { captureId: string };
  'capture.nack': {
    captureId?: string;
    code:
      | 'schema_mismatch'
      | 'asset_unavailable'
      | 'policy_denied'
      | 'backpressure'
      | 'storage_unavailable'
      | 'conflict'
      | 'unknown';
    message: string;
  };
  'helper.shutdown': { reason: 'quit' | 'restart' | 'runtime_stop' };
};

export type HelperToMainType = keyof HelperToMainPayloadByType;
export type MainToHelperType = keyof MainToHelperPayloadByType;
export type HelperMessageType = HelperToMainType | MainToHelperType;

export type HelperEnvelope<TType extends HelperMessageType = HelperMessageType> = {
  protocolVersion: HelperProtocolVersion;
  messageId: string;
  correlationId: string | null;
  sentAt: string;
  type: TType;
  payload: TType extends HelperToMainType
    ? HelperToMainPayloadByType[TType]
    : TType extends MainToHelperType
      ? MainToHelperPayloadByType[TType]
      : never;
};

export type HelperToMainEnvelope = HelperEnvelope<HelperToMainType>;
export type MainToHelperEnvelope = HelperEnvelope<MainToHelperType>;
