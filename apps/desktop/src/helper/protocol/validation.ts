import {
  HELPER_PROTOCOL_VERSION,
  type HelperEnvelope,
  type HelperMessageType,
  type HelperProtocolErrorCode,
  type HelperProtocolResult,
  type HelperToMainEnvelope,
  type HelperToMainType,
  type MainToHelperEnvelope,
  type MainToHelperType,
} from './types';

export type HelperEnvelopeValidator<TEnvelope extends HelperEnvelope> = (
  value: unknown,
) => HelperProtocolResult<TEnvelope>;

const HELPER_TO_MAIN_TYPES: readonly HelperToMainType[] = [
  'helper.hello',
  'helper.status',
  'permission.status',
  'capture.result',
  'capture.skipped',
  'capture.error',
  'helper.heartbeat',
  'helper.exiting',
];

const MAIN_TO_HELPER_TYPES: readonly MainToHelperType[] = [
  'helper.configure',
  'permission.refresh',
  'permission.request_screen_capture',
  'capture.start',
  'capture.pause',
  'capture.resume',
  'capture.flush',
  'capture.ack',
  'capture.nack',
  'helper.shutdown',
];

export const validateHelperToMainEnvelope: HelperEnvelopeValidator<HelperToMainEnvelope> = (
  value,
) => validateDirectionalEnvelope(value, isHelperToMainType);

export const validateMainToHelperEnvelope: HelperEnvelopeValidator<MainToHelperEnvelope> = (
  value,
) => validateDirectionalEnvelope(value, isMainToHelperType);

function validateDirectionalEnvelope<TEnvelope extends HelperEnvelope>(
  value: unknown,
  isAllowedType: (type: string) => type is TEnvelope['type'],
): HelperProtocolResult<TEnvelope> {
  if (!isRecord(value)) {
    return protocolError('schema_mismatch', 'Helper envelope must be an object.');
  }

  const type = value.type;
  if (value.protocolVersion !== HELPER_PROTOCOL_VERSION) {
    return protocolError(
      'unsupported_protocol_version',
      'Helper protocol version is not supported.',
      protocolErrorMetadata(value, safeKnownMessageType(type)),
    );
  }

  if (!isString(value.messageId) || !isString(value.sentAt)) {
    return protocolError(
      'schema_mismatch',
      'Helper envelope metadata is invalid.',
      protocolErrorMetadata(value, safeKnownMessageType(type)),
    );
  }

  if (value.correlationId !== null && !isString(value.correlationId)) {
    return protocolError(
      'schema_mismatch',
      'Helper envelope correlation id is invalid.',
      protocolErrorMetadata(value, safeKnownMessageType(type)),
    );
  }

  if (!isString(type)) {
    return protocolError(
      'schema_mismatch',
      'Helper envelope type is invalid.',
      protocolErrorMetadata(value),
    );
  }

  if (!isKnownMessageType(type)) {
    return protocolError(
      'unknown_message_type',
      'Helper envelope type is not recognized.',
      protocolErrorMetadata(value),
    );
  }

  if (!isAllowedType(type)) {
    return protocolError(
      'schema_mismatch',
      'Helper envelope type is not valid for this protocol direction.',
      protocolErrorMetadata(value, type),
    );
  }

  if (!isPayloadForType(type, value.payload)) {
    return protocolError(
      'schema_mismatch',
      'Helper envelope payload does not match its message type.',
      protocolErrorMetadata(value, type),
    );
  }

  return { envelope: value as TEnvelope, ok: true };
}

function isPayloadForType(type: HelperMessageType, payload: unknown): boolean {
  switch (type) {
    case 'helper.hello':
      return isHelperHelloPayload(payload);
    case 'helper.status':
      return isHelperStatusPayload(payload);
    case 'permission.status':
      return isPermissionStatusPayload(payload);
    case 'capture.result':
      return isCaptureResultPayload(payload);
    case 'capture.skipped':
      return isCaptureSkippedPayload(payload);
    case 'capture.error':
      return isCaptureErrorPayload(payload);
    case 'helper.heartbeat':
      return isHelperHeartbeatPayload(payload);
    case 'helper.exiting':
      return isHelperExitingPayload(payload);
    case 'helper.configure':
      return isHelperConfigurePayload(payload);
    case 'permission.refresh':
    case 'permission.request_screen_capture':
      return isRecord(payload) && hasOnlyKeys(payload, []);
    case 'capture.start':
      return isReasonPayload(payload, ['runtime_started', 'user_resumed']);
    case 'capture.pause':
      return isReasonPayload(payload, [
        'user_paused',
        'backpressure',
        'permission_missing',
        'runtime_stopping',
      ]);
    case 'capture.resume':
      return isReasonPayload(payload, ['user_resumed', 'backpressure_relieved']);
    case 'capture.flush':
      return isReasonPayload(payload, ['shutdown', 'manual']);
    case 'capture.ack':
      return (
        isRecord(payload) && hasOnlyKeys(payload, ['captureId']) && isString(payload.captureId)
      );
    case 'capture.nack':
      return isCaptureNackPayload(payload);
    case 'helper.shutdown':
      return isReasonPayload(payload, ['quit', 'restart', 'runtime_stop']);
  }
}

function isHelperHelloPayload(payload: unknown): boolean {
  return (
    isRecord(payload) &&
    hasOnlyKeys(payload, ['helperVersion', 'pid', 'capabilities']) &&
    isSafeVisibleString(payload.helperVersion) &&
    (typeof payload.pid === 'number' || payload.pid === null) &&
    isRecord(payload.capabilities) &&
    hasOnlyKeys(payload.capabilities, ['capture', 'permissions', 'mock']) &&
    typeof payload.capabilities.capture === 'boolean' &&
    typeof payload.capabilities.permissions === 'boolean' &&
    typeof payload.capabilities.mock === 'boolean'
  );
}

function isHelperStatusPayload(payload: unknown): boolean {
  return (
    isRecord(payload) &&
    hasOnlyKeys(payload, ['status', 'reason']) &&
    isOneOf(payload.status, ['starting', 'ready', 'paused', 'stopping', 'stopped', 'error']) &&
    optionalSafeVisibleString(payload.reason)
  );
}

function isPermissionStatusPayload(payload: unknown): boolean {
  return (
    isRecord(payload) &&
    hasOnlyKeys(payload, ['screenCapture', 'accessibility', 'observedAt']) &&
    isOneOf(payload.screenCapture, ['granted', 'denied', 'not_determined', 'unknown']) &&
    isOneOf(payload.accessibility, ['granted', 'denied', 'not_determined', 'unknown']) &&
    isString(payload.observedAt)
  );
}

function isCaptureResultPayload(payload: unknown): boolean {
  return (
    isRecord(payload) &&
    hasOnlyKeys(payload, ['captureId', 'observedAt', 'manifest', 'assets', 'context']) &&
    isString(payload.captureId) &&
    isString(payload.observedAt) &&
    isCaptureAssetPayload(payload.manifest) &&
    Array.isArray(payload.assets) &&
    payload.assets.every(isCaptureAssetPayload) &&
    isSafeCaptureContextPayload(payload.context)
  );
}

function isCaptureAssetPayload(payload: unknown): boolean {
  return (
    isRecord(payload) &&
    hasOnlyKeys(payload, ['role', 'ref', 'hash', 'mimeType', 'sizeBytes']) &&
    isOneOf(payload.role, ['screenshot', 'thumbnail', 'manifest']) &&
    isOpaqueRef(payload.ref) &&
    isString(payload.hash) &&
    isString(payload.mimeType) &&
    typeof payload.sizeBytes === 'number' &&
    Number.isInteger(payload.sizeBytes) &&
    payload.sizeBytes >= 0
  );
}

function isSafeCaptureContextPayload(payload: unknown): boolean {
  return (
    isRecord(payload) &&
    hasOnlyKeys(payload, ['observedAt', 'app', 'window', 'website', 'document', 'policy']) &&
    isString(payload.observedAt) &&
    isOptionalApp(payload.app) &&
    isOptionalWindow(payload.window) &&
    isOptionalWebsite(payload.website) &&
    isOptionalDocument(payload.document) &&
    isRecord(payload.policy) &&
    hasOnlyKeys(payload.policy, ['version', 'decision']) &&
    isString(payload.policy.version) &&
    isOneOf(payload.policy.decision, ['allow', 'redact_context', 'block_ocr'])
  );
}

function isCaptureSkippedPayload(payload: unknown): boolean {
  return (
    isRecord(payload) &&
    hasOnlyKeys(payload, ['captureId', 'reason', 'observedAt']) &&
    isString(payload.captureId) &&
    isOneOf(payload.reason, [
      'paused',
      'policy_denied',
      'duplicate',
      'blank',
      'secure_input',
      'private_context',
    ]) &&
    isString(payload.observedAt)
  );
}

function isCaptureErrorPayload(payload: unknown): boolean {
  return (
    isRecord(payload) &&
    hasOnlyKeys(payload, ['captureId', 'code', 'message']) &&
    optionalString(payload.captureId) &&
    isOneOf(payload.code, [
      'capture_failed',
      'permission_missing',
      'permission_revoked',
      'asset_write_failed',
      'helper_unavailable',
      'unknown',
    ]) &&
    isSafeVisibleString(payload.message)
  );
}

function isHelperHeartbeatPayload(payload: unknown): boolean {
  return (
    isRecord(payload) &&
    hasOnlyKeys(payload, ['sequence', 'status']) &&
    typeof payload.sequence === 'number' &&
    Number.isInteger(payload.sequence) &&
    payload.sequence >= 0 &&
    isOneOf(payload.status, ['starting', 'ready', 'paused', 'stopping'])
  );
}

function isHelperExitingPayload(payload: unknown): boolean {
  return (
    isRecord(payload) &&
    hasOnlyKeys(payload, ['reason', 'code']) &&
    isOneOf(payload.reason, [
      'shutdown_requested',
      'quit_requested',
      'process_crashed',
      'unknown',
    ]) &&
    (Number.isInteger(payload.code) || payload.code === null)
  );
}

function isHelperConfigurePayload(payload: unknown): boolean {
  return (
    isRecord(payload) &&
    hasOnlyKeys(payload, ['captureIntervalMs', 'policyVersion']) &&
    optionalInteger(payload.captureIntervalMs) &&
    isString(payload.policyVersion)
  );
}

function isCaptureNackPayload(payload: unknown): boolean {
  return (
    isRecord(payload) &&
    hasOnlyKeys(payload, ['captureId', 'code', 'message']) &&
    optionalString(payload.captureId) &&
    isOneOf(payload.code, [
      'schema_mismatch',
      'asset_unavailable',
      'policy_denied',
      'backpressure',
      'storage_unavailable',
      'conflict',
      'unknown',
    ]) &&
    isSafeVisibleString(payload.message)
  );
}

function isReasonPayload(payload: unknown, reasons: readonly string[]): boolean {
  return isRecord(payload) && hasOnlyKeys(payload, ['reason']) && isOneOf(payload.reason, reasons);
}

function isOptionalApp(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      hasOnlyKeys(value, ['name', 'bundleId']) &&
      isSafeVisibleString(value.name) &&
      isString(value.bundleId))
  );
}

function isOptionalWindow(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) && hasOnlyKeys(value, ['title']) && isSafeVisibleString(value.title))
  );
}

function isOptionalWebsite(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      hasOnlyKeys(value, ['origin', 'host']) &&
      isSafeWebsiteOrigin(value.origin, value.host))
  );
}

function isOptionalDocument(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) && hasOnlyKeys(value, ['name']) && isSafeDocumentName(value.name))
  );
}

function isOpaqueRef(value: unknown): boolean {
  return isString(value) && !isLocalAbsolutePath(value) && !value.startsWith('file://');
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isHelperToMainType(type: string): type is HelperToMainType {
  return HELPER_TO_MAIN_TYPES.includes(type as HelperToMainType);
}

function isMainToHelperType(type: string): type is MainToHelperType {
  return MAIN_TO_HELPER_TYPES.includes(type as MainToHelperType);
}

function isKnownMessageType(type: string): type is HelperMessageType {
  return isHelperToMainType(type) || isMainToHelperType(type);
}

function safeKnownMessageType(type: unknown): HelperMessageType | undefined {
  return isString(type) && isKnownMessageType(type) ? type : undefined;
}

type ProtocolErrorMetadata = {
  captureId?: string;
  correlationId?: string | null;
  messageId?: string;
  messageType?: HelperMessageType;
};

function protocolError<TEnvelope extends HelperEnvelope>(
  code: HelperProtocolErrorCode,
  message: string,
  metadata: ProtocolErrorMetadata = {},
): HelperProtocolResult<TEnvelope> {
  return {
    error: {
      code,
      message,
      ...(metadata.captureId ? { captureId: metadata.captureId } : {}),
      ...(metadata.correlationId !== undefined ? { correlationId: metadata.correlationId } : {}),
      ...(metadata.messageId ? { messageId: metadata.messageId } : {}),
      ...(metadata.messageType ? { messageType: metadata.messageType } : {}),
    },
    ok: false,
  };
}

function protocolErrorMetadata(
  value: Record<string, unknown>,
  messageType?: HelperMessageType,
): ProtocolErrorMetadata {
  const metadata: ProtocolErrorMetadata = { ...(messageType ? { messageType } : {}) };

  if (isSafeProtocolIdentifier(value.messageId)) metadata.messageId = value.messageId;
  if (value.correlationId === null) {
    metadata.correlationId = null;
  } else if (isSafeProtocolIdentifier(value.correlationId)) {
    metadata.correlationId = value.correlationId;
  }

  if (messageType?.startsWith('capture.') && isRecord(value.payload)) {
    const captureId = value.payload.captureId;
    if (isSafeProtocolIdentifier(captureId)) metadata.captureId = captureId;
  }

  return metadata;
}

function isSafeProtocolIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/.test(value) &&
    !SECRET_WORD_PATTERN.test(value)
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || isString(value);
}

function optionalSafeVisibleString(value: unknown): boolean {
  return value === undefined || isSafeVisibleString(value);
}

function optionalInteger(value: unknown): boolean {
  return value === undefined || (Number.isInteger(value) && Number(value) >= 0);
}

function isOneOf<TValue extends string>(
  value: unknown,
  allowed: readonly TValue[],
): value is TValue {
  return isString(value) && allowed.includes(value as TValue);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

const FILE_URL_PATTERN = /^file:\/\//i;
const SECRET_WORD_PATTERN = /\b(token|secret|password|credential|api[ _-]?key)\b/i;
const API_KEY_VALUE_PATTERN = /\bsk-[A-Za-z0-9_-]{12,}\b/;
const SECRET_QUERY_KEY_PATTERN =
  /^(token|auth|access_token|refresh_token|secret|password|credential|api[_-]?key)$/i;

function isSafeVisibleString(value: unknown): value is string {
  return isString(value) && !isUnsafeVisibleString(value);
}

function isSafeDocumentName(value: unknown): value is string {
  return (
    isSafeVisibleString(value) &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !FILE_URL_PATTERN.test(value)
  );
}

function isSafeWebsiteOrigin(origin: unknown, host: unknown): boolean {
  if (!isString(origin) || !isString(host)) return false;

  try {
    const url = new URL(origin);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.origin === origin &&
      url.host === host &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function isUnsafeVisibleString(value: string): boolean {
  return (
    isLocalAbsolutePath(value) ||
    FILE_URL_PATTERN.test(value) ||
    SECRET_WORD_PATTERN.test(value) ||
    API_KEY_VALUE_PATTERN.test(value) ||
    hasUrlQuerySecret(value)
  );
}

function hasUrlQuerySecret(value: string): boolean {
  try {
    const url = new URL(value);
    for (const key of url.searchParams.keys()) {
      if (SECRET_QUERY_KEY_PATTERN.test(key)) return true;
    }
  } catch {
    return /https?:\/\/\S+[?&](token|auth|access_token|refresh_token|secret|password|credential|api[_-]?key)=/i.test(
      value,
    );
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLocalAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}
