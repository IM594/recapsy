import type { LocalCapturePolicyRuleKind } from '@recapsy/contracts';
import type {
  CaptureStatusDto,
  LocalCapturePolicyRulesDto,
  PermissionStatusDto,
  PrivacySettingsOpenResultDto,
  RetentionExecutionDto,
  RetentionPreviewDto,
  SyncGateStatusDto,
  SyncQueueSummaryDto,
  SyncTerminalRecoveryDto,
} from './dto';
import { type IpcErrorEnvelope, createIpcErrorEnvelope } from './errors';

export type IpcNamespace = 'capture' | 'sync' | 'diagnostics' | 'permissions';

export type RequestValidationResult<TRequest> =
  | {
      ok: true;
      value: TRequest;
    }
  | {
      ok: false;
      issues: string[];
    };

export type IpcChannelDefinition<TRequest = unknown, TResponse = unknown> = {
  namespace: IpcNamespace;
  channel: `${IpcNamespace}.${string}`;
  methodName: string;
  description: string;
  validateRequest(payload: unknown): RequestValidationResult<TRequest>;
  response: TResponse;
};

const empty = {};

export const IPC_CHANNEL_REGISTRY = [
  defineChannel<EmptyRequest, CaptureStatusDto>({
    channel: 'capture.getStatus',
    description: 'Returns capture and permission status without local file details.',
    methodName: 'captureGetStatus',
    namespace: 'capture',
    request: validateEmptyRequest,
  }),
  defineChannel<EmptyRequest, LocalCapturePolicyRulesDto>({
    channel: 'capture.listLocalRules',
    description: 'Returns device-profile application and website blocks without capture content.',
    methodName: 'captureListLocalRules',
    namespace: 'capture',
    request: validateEmptyRequest,
  }),
  defineChannel<{ bundleId: string }, LocalCapturePolicyRulesDto>({
    channel: 'capture.blockBundle',
    description: 'Blocks future capture for one exact local application bundle identifier.',
    methodName: 'captureBlockBundle',
    namespace: 'capture',
    request: validateBundleIdentifierRequest,
  }),
  defineChannel<{ kind: LocalCapturePolicyRuleKind; pattern: string }, LocalCapturePolicyRulesDto>({
    channel: 'capture.addLocalRule',
    description: 'Stores one exact application, exact-domain, or website-family capture block.',
    methodName: 'captureAddLocalRule',
    namespace: 'capture',
    request: validateLocalCapturePolicyRuleRequest,
  }),
  defineChannel<{ ruleId: string }, LocalCapturePolicyRulesDto>({
    channel: 'capture.removeLocalRule',
    description: 'Removes one device-profile capture block by opaque local rule id.',
    methodName: 'captureRemoveLocalRule',
    namespace: 'capture',
    request: validateLocalRuleRequest,
  }),
  defineChannel<EmptyRequest, CaptureStatusDto>({
    channel: 'capture.pause',
    description: 'Pauses new capture while keeping the desktop runtime alive.',
    methodName: 'capturePause',
    namespace: 'capture',
    request: validateEmptyRequest,
  }),
  defineChannel<EmptyRequest, CaptureStatusDto>({
    channel: 'capture.resume',
    description: 'Resumes capture after a pause.',
    methodName: 'captureResume',
    namespace: 'capture',
    request: validateEmptyRequest,
  }),
  defineChannel<EmptyRequest, SyncQueueSummaryDto>({
    channel: 'sync.getSummary',
    description: 'Returns the local sync queue summary.',
    methodName: 'syncGetSummary',
    namespace: 'sync',
    request: validateEmptyRequest,
  }),
  defineChannel<EmptyRequest, SyncGateStatusDto>({
    channel: 'sync.resume',
    description: 'Explicitly reopens provider sync after an operator fixes credentials.',
    methodName: 'syncResume',
    namespace: 'sync',
    request: validateEmptyRequest,
  }),
  defineChannel<EmptyRequest, SyncTerminalRecoveryDto>({
    channel: 'sync.requeueTerminal',
    description: 'Requeues failed and blocked jobs in the active workspace.',
    methodName: 'syncRequeueTerminal',
    namespace: 'sync',
    request: validateEmptyRequest,
  }),
  defineChannel<{ olderThanDays: number }, RetentionPreviewDto>({
    channel: 'diagnostics.previewRetention',
    description: 'Returns a read-only local retention preview without file paths.',
    methodName: 'diagnosticsPreviewRetention',
    namespace: 'diagnostics',
    request: validateRetentionPreviewRequest,
  }),
  defineChannel<{ olderThanDays: number }, RetentionExecutionDto>({
    channel: 'diagnostics.runRetention',
    description: 'Deletes the explicitly reviewed local retention set without exposing file paths.',
    methodName: 'diagnosticsRunRetention',
    namespace: 'diagnostics',
    request: validateRetentionPreviewRequest,
  }),
  defineChannel<EmptyRequest, PermissionStatusDto>({
    channel: 'permissions.getStatus',
    description: 'Returns native screen-recording and accessibility permission state.',
    methodName: 'permissionsGetStatus',
    namespace: 'permissions',
    request: validateEmptyRequest,
  }),
  defineChannel<EmptyRequest, PermissionStatusDto>({
    channel: 'permissions.refresh',
    description: 'Asks the capture process to re-probe permissions and returns the result.',
    methodName: 'permissionsRefresh',
    namespace: 'permissions',
    request: validateEmptyRequest,
  }),
  defineChannel<EmptyRequest, PermissionStatusDto>({
    channel: 'permissions.requestScreenRecording',
    description: 'Explicitly requests Screen Recording access after a user action.',
    methodName: 'permissionsRequestScreenRecording',
    namespace: 'permissions',
    request: validateEmptyRequest,
  }),
  defineChannel<EmptyRequest, PrivacySettingsOpenResultDto>({
    channel: 'permissions.openScreenRecordingSettings',
    description: 'Opens the macOS Screen Recording privacy pane.',
    methodName: 'permissionsOpenScreenRecordingSettings',
    namespace: 'permissions',
    request: validateEmptyRequest,
  }),
  defineChannel<EmptyRequest, PrivacySettingsOpenResultDto>({
    channel: 'permissions.openAccessibilitySettings',
    description: 'Opens the macOS Accessibility privacy pane.',
    methodName: 'permissionsOpenAccessibilitySettings',
    namespace: 'permissions',
    request: validateEmptyRequest,
  }),
] as const;

export type IpcChannelName = (typeof IPC_CHANNEL_REGISTRY)[number]['channel'];
export type IpcPreloadMethodName = (typeof IPC_CHANNEL_REGISTRY)[number]['methodName'];

export type IpcRequestValidation =
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
      error: IpcErrorEnvelope;
    };

export function validateIpcRequest(
  channel: IpcChannelName,
  payload: unknown,
): IpcRequestValidation {
  const definition = IPC_CHANNEL_REGISTRY.find((entry) => entry.channel === channel);

  if (!definition) {
    return {
      error: createIpcErrorEnvelope('validation_failed', `Unknown IPC channel: ${channel}.`),
      ok: false,
    };
  }

  const result = definition.validateRequest(payload);

  if (result.ok) {
    return result;
  }

  return {
    error: createIpcErrorEnvelope('validation_failed', `Invalid request for ${channel}.`, {
      issues: result.issues,
    }),
    ok: false,
  };
}

type EmptyRequest = Record<string, never>;

function defineChannel<TRequest, TResponse>(input: {
  namespace: IpcNamespace;
  channel: `${IpcNamespace}.${string}`;
  methodName: string;
  description: string;
  request(payload: unknown): RequestValidationResult<TRequest>;
}): IpcChannelDefinition<TRequest, TResponse> {
  return {
    channel: input.channel,
    description: input.description,
    methodName: input.methodName,
    namespace: input.namespace,
    response: undefined as TResponse,
    validateRequest: input.request,
  };
}

function validateEmptyRequest(payload: unknown): RequestValidationResult<EmptyRequest> {
  if (payload === undefined || (isRecord(payload) && Object.keys(payload).length === 0)) {
    return {
      ok: true,
      value: empty,
    };
  }

  return {
    issues: ['request must be empty'],
    ok: false,
  };
}

function validateBundleIdentifierRequest(
  payload: unknown,
): RequestValidationResult<{ bundleId: string }> {
  if (!isRecord(payload) || Object.keys(payload).some((key) => key !== 'bundleId')) {
    return { issues: ['request must contain only bundleId'], ok: false };
  }
  if (
    typeof payload.bundleId !== 'string' ||
    payload.bundleId.length > 255 ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*(?:[.][A-Za-z0-9][A-Za-z0-9-]*)+$/.test(payload.bundleId)
  ) {
    return { issues: ['bundleId must be an exact application bundle identifier'], ok: false };
  }
  return { ok: true, value: { bundleId: payload.bundleId } };
}

function validateLocalCapturePolicyRuleRequest(
  payload: unknown,
): RequestValidationResult<{ kind: LocalCapturePolicyRuleKind; pattern: string }> {
  if (
    !isRecord(payload) ||
    Object.keys(payload).some((key) => key !== 'kind' && key !== 'pattern')
  ) {
    return { issues: ['request must contain only kind and pattern'], ok: false };
  }

  if (
    payload.kind !== 'bundle_id' &&
    payload.kind !== 'domain' &&
    payload.kind !== 'domain_family'
  ) {
    return { issues: ['kind must be bundle_id, domain, or domain_family'], ok: false };
  }
  if (typeof payload.pattern !== 'string' || payload.pattern.length === 0) {
    return { issues: ['pattern must be a non-empty string'], ok: false };
  }
  if (payload.kind === 'bundle_id' && !isBundleIdentifier(payload.pattern)) {
    return { issues: ['pattern must be an exact application bundle identifier'], ok: false };
  }
  if (
    (payload.kind === 'domain' || payload.kind === 'domain_family') &&
    !isDomainPattern(payload.pattern)
  ) {
    return { issues: ['pattern must be a hostname without a URL or path'], ok: false };
  }

  return {
    ok: true,
    value: { kind: payload.kind, pattern: payload.pattern },
  };
}

function validateLocalRuleRequest(payload: unknown): RequestValidationResult<{ ruleId: string }> {
  if (
    !isRecord(payload) ||
    Object.keys(payload).some((key) => key !== 'ruleId') ||
    typeof payload.ruleId !== 'string' ||
    !/^local:[a-f0-9]{6,64}$/.test(payload.ruleId)
  ) {
    return { issues: ['ruleId must be an opaque local rule id'], ok: false };
  }
  return { ok: true, value: { ruleId: payload.ruleId } };
}

function isBundleIdentifier(value: string): boolean {
  return (
    value.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9-]*(?:[.][A-Za-z0-9][A-Za-z0-9-]*)+$/.test(value)
  );
}

function isDomainPattern(value: string): boolean {
  if (value !== value.trim() || value.length > 253 || value.includes('\u0000')) return false;
  if (value.includes('/') || value.includes(':') || value.includes('?') || value.includes('#')) {
    return false;
  }

  return value.split('.').every((label) => {
    return (
      label.length >= 1 &&
      label.length <= 63 &&
      /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
    );
  });
}

function validateRetentionPreviewRequest(
  payload: unknown,
): RequestValidationResult<{ olderThanDays: number }> {
  if (!isRecord(payload)) {
    return { issues: ['request must be an object'], ok: false };
  }

  const issues = [
    ...(Object.keys(payload).some((key) => key !== 'olderThanDays')
      ? ['retention preview must contain only olderThanDays']
      : []),
    ...(typeof payload.olderThanDays === 'number' &&
    Number.isInteger(payload.olderThanDays) &&
    payload.olderThanDays >= 1 &&
    payload.olderThanDays <= 36_500
      ? []
      : ['olderThanDays must be a whole number between 1 and 36500']),
  ];
  if (issues.length > 0) {
    return { issues, ok: false };
  }

  return { ok: true, value: { olderThanDays: payload.olderThanDays as number } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
