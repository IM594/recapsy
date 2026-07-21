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

export type CaptureAssetRole = 'screenshot';

export type CaptureAssetPayload = {
  role: CaptureAssetRole;
  ref: string;
  hash: string;
  mimeType: string;
  sizeBytes: number;
};

export type HelperCapturePolicyAction = 'allow' | 'block_capture' | 'redact_context' | 'block_ocr';

export type HelperCapturePolicyRule = {
  id: string;
  kind: 'pause' | 'app_name' | 'bundle_id' | 'domain' | 'document_path' | 'window_title';
  scope: 'hard' | 'local_user' | 'workspace_default';
  pattern: string;
  action: HelperCapturePolicyAction;
  enabled: boolean;
};

export type HelperCapturePolicy = {
  policyHash: string;
  version: string;
  paused: boolean;
  defaultAction: HelperCapturePolicyAction;
  rules: HelperCapturePolicyRule[];
};

/** Scope used by the native receipt journal during crash recovery. */
export type HelperCaptureIdentity = {
  workspaceId: string;
  deviceId: string;
};

export type SafeCaptureContextPayload = {
  observedAt: string;
  app: { name: string; bundleId: string };
  window?: { title: string };
  website?: { origin: string; host: string };
  document?: { name: string };
  policy: {
    version: string;
    decision: 'allow' | 'redact_context' | 'block_ocr';
  };
};

// Mirrors `@recapsy/contracts`' `CaptureCoverageStateSchema` values. Declared
// locally rather than imported: this file is a self-contained wire vocabulary
// with no runtime dependencies (see the `CaptureAssetRole` /
// `HelperCapturePolicyAction` types below for the same pattern); the shared
// business vocabulary is bridged at the capability boundary instead (see
// `capture/coverage-aggregator.ts`).
export type CaptureCoverageState =
  | 'static'
  | 'blank'
  | 'low_information'
  | 'no_window'
  | 'privacy_withheld'
  | 'secure_field'
  | 'private_context'
  | 'paused';

export type CaptureResultPayload = {
  captureId: string;
  observedAt: string;
  /**
   * The wall-clock instant the frame was presented on screen, as measured by
   * the native capture layer — distinct from `observedAt`, which is the tick
   * scheduler's timestamp. Optional so a helper that does not yet report it
   * falls back to `observedAt` (see `capture/outbox-entry.ts`).
   */
  capturedAt?: string;
  /**
   * Native capture-layer frame-quality fact measured at accept time: a coarse
   * luminance bucket and whether the frame was borderline (near-blank /
   * low-contrast). Optional so mock or older helpers may omit it; used to
   * derive OCR quality flags (see `sync/screen-text.ts`).
   */
  frameQuality?: { luminanceBucket: number; marginal: boolean };
  assets: [CaptureAssetPayload];
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
  'helper.policy_applied': {
    policyHash: string;
    policyVersion: string;
  };
  'permission.status': {
    screenCapture: 'granted' | 'denied' | 'not_determined' | 'unknown';
    accessibility: 'granted' | 'denied' | 'not_determined' | 'unknown';
    observedAt: string;
  };
  'capture.result': CaptureResultPayload;
  /**
   * A tick produced no frame; `state` is the reason, recorded as a coverage
   * fact rather than discarded (see `capture/coverage-aggregator.ts`). Shares
   * its state vocabulary with the server contract's capture-coverage spine.
   */
  'capture.coverage': {
    captureId: string;
    state: CaptureCoverageState;
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
  'helper.configure': {
    captureIdentity?: HelperCaptureIdentity;
    captureIntervalMs?: number;
    policy: HelperCapturePolicy;
  };
  'permission.refresh': Record<string, never>;
  'permission.request_screen_capture': Record<string, never>;
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
