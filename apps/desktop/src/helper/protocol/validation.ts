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
  'helper.policy_applied',
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
    case 'helper.policy_applied':
      return isHelperPolicyAppliedPayload(payload);
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
        isRecord(payload) &&
        hasOnlyKeys(payload, ['captureId']) &&
        isSafeCaptureId(payload.captureId)
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

function isHelperPolicyAppliedPayload(payload: unknown): boolean {
  return (
    isRecord(payload) &&
    hasOnlyKeys(payload, ['policyHash', 'policyVersion']) &&
    isPolicyHash(payload.policyHash) &&
    isString(payload.policyVersion)
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
    hasOnlyKeys(payload, ['captureId', 'observedAt', 'assets', 'context']) &&
    isSafeCaptureId(payload.captureId) &&
    isString(payload.observedAt) &&
    Array.isArray(payload.assets) &&
    payload.assets.length === 1 &&
    isCaptureAssetPayload(payload.assets[0], payload.captureId) &&
    isSafeCaptureContextPayload(payload.context, payload.observedAt)
  );
}

function isCaptureAssetPayload(payload: unknown, captureId: string): boolean {
  return (
    isRecord(payload) &&
    hasOnlyKeys(payload, ['role', 'ref', 'hash', 'mimeType', 'sizeBytes']) &&
    payload.role === 'screenshot' &&
    payload.ref === `${captureId}/screenshot.webp` &&
    isPolicyHash(payload.hash) &&
    payload.mimeType === 'image/webp' &&
    typeof payload.sizeBytes === 'number' &&
    Number.isInteger(payload.sizeBytes) &&
    payload.sizeBytes > 0
  );
}

function isSafeCaptureContextPayload(payload: unknown, observedAt?: string): boolean {
  return (
    isRecord(payload) &&
    hasOnlyKeys(payload, ['observedAt', 'app', 'window', 'website', 'document', 'policy']) &&
    isString(payload.observedAt) &&
    (observedAt === undefined || payload.observedAt === observedAt) &&
    isApp(payload.app) &&
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
    isSafeCaptureId(payload.captureId) &&
    isOneOf(payload.reason, [
      'paused',
      'policy_denied',
      'duplicate',
      'blank',
      'low_information',
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
    optionalSafeCaptureId(payload.captureId) &&
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
    hasOnlyKeys(payload, ['captureIdentity', 'captureIntervalMs', 'policy']) &&
    optionalCaptureIdentity(payload.captureIdentity) &&
    optionalInteger(payload.captureIntervalMs) &&
    isHelperCapturePolicy(payload.policy)
  );
}

function optionalCaptureIdentity(payload: unknown): boolean {
  return (
    payload === undefined ||
    (isRecord(payload) &&
      hasOnlyKeys(payload, ['workspaceId', 'deviceId']) &&
      isString(payload.workspaceId) &&
      payload.workspaceId.length > 0 &&
      isString(payload.deviceId) &&
      payload.deviceId.length > 0)
  );
}

function isHelperCapturePolicy(payload: unknown): boolean {
  return (
    isRecord(payload) &&
    hasOnlyKeys(payload, ['policyHash', 'version', 'paused', 'defaultAction', 'rules']) &&
    isPolicyHash(payload.policyHash) &&
    isString(payload.version) &&
    typeof payload.paused === 'boolean' &&
    isPolicyAction(payload.defaultAction) &&
    Array.isArray(payload.rules) &&
    payload.rules.every(isHelperCapturePolicyRule)
  );
}

function isHelperCapturePolicyRule(payload: unknown): boolean {
  return (
    isRecord(payload) &&
    hasOnlyKeys(payload, ['id', 'kind', 'scope', 'pattern', 'action', 'enabled']) &&
    isString(payload.id) &&
    isOneOf(payload.kind, [
      'pause',
      'app_name',
      'bundle_id',
      'domain',
      'document_path',
      'window_title',
    ]) &&
    isOneOf(payload.scope, ['hard', 'local_user', 'workspace_default']) &&
    isString(payload.pattern) &&
    isPolicyAction(payload.action) &&
    typeof payload.enabled === 'boolean'
  );
}

function isPolicyAction(value: unknown): boolean {
  return isOneOf(value, ['allow', 'block_capture', 'redact_context', 'block_ocr']);
}

function isPolicyHash(value: unknown): boolean {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isCaptureNackPayload(payload: unknown): boolean {
  return (
    isRecord(payload) &&
    hasOnlyKeys(payload, ['captureId', 'code', 'message']) &&
    optionalSafeCaptureId(payload.captureId) &&
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

function isApp(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['name', 'bundleId']) &&
    isSafeVisibleString(value.name) &&
    value.name.trim().length > 0 &&
    isString(value.bundleId) &&
    value.bundleId.length <= 256 &&
    /^[A-Za-z0-9.-]+$/.test(value.bundleId)
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
    if (isSafeCaptureId(captureId)) metadata.captureId = captureId;
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

export function isSafeCaptureId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_CAPTURE_ID_PATTERN.test(value);
}

function optionalSafeCaptureId(value: unknown): boolean {
  return value === undefined || isSafeCaptureId(value);
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
const SAFE_CAPTURE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
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
