import type {
  CaptureEventSummaryDto,
  CaptureStatusDto,
  DiagnosticsBundleDto,
  DiagnosticsLogEntryDto,
  OcrJobSummaryDto,
  RuntimeStatusDto,
  SafeSessionSummary,
  SearchQueryRequestDto,
  SearchQueryResponseDto,
  SettingsRuntimeDto,
  SyncQueueSummaryDto,
  TimelineQueryRequestDto,
  TimelineQueryResponseDto,
  WorkspaceCapabilitiesDto,
  WorkspaceSummaryDto,
} from './dto';
import { type IpcErrorEnvelope, createIpcErrorEnvelope } from './errors';

export type IpcNamespace =
  | 'session'
  | 'workspace'
  | 'capture'
  | 'sync'
  | 'ocr'
  | 'timeline'
  | 'search'
  | 'settings'
  | 'diagnostics';

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
  defineChannel<EmptyRequest, SafeSessionSummary>({
    channel: 'session.getCurrent',
    description: 'Returns the renderer-safe session summary.',
    methodName: 'sessionGetCurrent',
    namespace: 'session',
    request: validateEmptyRequest,
  }),
  defineChannel<{ redirectUri?: string }, SafeSessionSummary>({
    channel: 'session.signIn',
    description: 'Starts a sign-in flow without exposing auth tokens to the renderer.',
    methodName: 'sessionSignIn',
    namespace: 'session',
    request: validateOptionalRedirectRequest,
  }),
  defineChannel<EmptyRequest, SafeSessionSummary>({
    channel: 'session.signOut',
    description: 'Signs out and returns the resulting safe session summary.',
    methodName: 'sessionSignOut',
    namespace: 'session',
    request: validateEmptyRequest,
  }),
  defineChannel<EmptyRequest, SafeSessionSummary>({
    channel: 'session.refresh',
    description: 'Refreshes the session through main-owned token storage.',
    methodName: 'sessionRefresh',
    namespace: 'session',
    request: validateEmptyRequest,
  }),
  defineChannel<EmptyRequest, WorkspaceSummaryDto | null>({
    channel: 'workspace.getCurrent',
    description: 'Returns the current workspace summary.',
    methodName: 'workspaceGetCurrent',
    namespace: 'workspace',
    request: validateEmptyRequest,
  }),
  defineChannel<{ workspaceId: string }, WorkspaceSummaryDto>({
    channel: 'workspace.switch',
    description: 'Switches the current workspace by opaque workspace id.',
    methodName: 'workspaceSwitch',
    namespace: 'workspace',
    request: validateWorkspaceSwitchRequest,
  }),
  defineChannel<EmptyRequest, WorkspaceCapabilitiesDto>({
    channel: 'workspace.getCapabilities',
    description: 'Returns current workspace capability flags.',
    methodName: 'workspaceGetCapabilities',
    namespace: 'workspace',
    request: validateEmptyRequest,
  }),
  defineChannel<EmptyRequest, CaptureStatusDto>({
    channel: 'capture.getStatus',
    description: 'Returns capture and permission status without local file details.',
    methodName: 'captureGetStatus',
    namespace: 'capture',
    request: validateEmptyRequest,
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
  defineChannel<{ limit?: number }, { events: CaptureEventSummaryDto[] }>({
    channel: 'capture.getRecentEvents',
    description: 'Returns safe recent capture event summaries.',
    methodName: 'captureGetRecentEvents',
    namespace: 'capture',
    request: validateOptionalLimitRequest(50),
  }),
  defineChannel<EmptyRequest, SyncQueueSummaryDto>({
    channel: 'sync.getSummary',
    description: 'Returns the local sync queue summary.',
    methodName: 'syncGetSummary',
    namespace: 'sync',
    request: validateEmptyRequest,
  }),
  defineChannel<{ jobId: string }, SyncQueueSummaryDto>({
    channel: 'sync.retry',
    description: 'Retries a blocked or failed sync job.',
    methodName: 'syncRetry',
    namespace: 'sync',
    request: validateJobRequest,
  }),
  defineChannel<{ jobId: string }, SyncQueueSummaryDto>({
    channel: 'sync.cancel',
    description: 'Cancels a pending sync job.',
    methodName: 'syncCancel',
    namespace: 'sync',
    request: validateJobRequest,
  }),
  defineChannel<EmptyRequest, SyncQueueSummaryDto>({
    channel: 'sync.flushNow',
    description: 'Requests an immediate sync queue flush.',
    methodName: 'syncFlushNow',
    namespace: 'sync',
    request: validateEmptyRequest,
  }),
  defineChannel<{ jobId: string }, OcrJobSummaryDto>({
    channel: 'ocr.getJob',
    description: 'Returns a safe OCR job summary.',
    methodName: 'ocrGetJob',
    namespace: 'ocr',
    request: validateJobRequest,
  }),
  defineChannel<{ jobId: string }, OcrJobSummaryDto>({
    channel: 'ocr.retryJob',
    description: 'Retries an OCR job through main-controlled sync flow.',
    methodName: 'ocrRetryJob',
    namespace: 'ocr',
    request: validateJobRequest,
  }),
  defineChannel<{ jobId: string }, OcrJobSummaryDto>({
    channel: 'ocr.cancelJob',
    description: 'Cancels an OCR job through main-controlled sync flow.',
    methodName: 'ocrCancelJob',
    namespace: 'ocr',
    request: validateJobRequest,
  }),
  defineChannel<TimelineQueryRequestDto, TimelineQueryResponseDto>({
    channel: 'timeline.query',
    description: 'Queries timeline results through the main process.',
    methodName: 'timelineQuery',
    namespace: 'timeline',
    request: validateTimelineQueryRequest,
  }),
  defineChannel<SearchQueryRequestDto, SearchQueryResponseDto>({
    channel: 'search.query',
    description: 'Queries processed memory search through the main process.',
    methodName: 'searchQuery',
    namespace: 'search',
    request: validateSearchQueryRequest,
  }),
  defineChannel<EmptyRequest, RuntimeStatusDto>({
    channel: 'settings.getRuntime',
    description: 'Returns runtime settings and helper capability status.',
    methodName: 'settingsGetRuntime',
    namespace: 'settings',
    request: validateEmptyRequest,
  }),
  defineChannel<Partial<SettingsRuntimeDto>, SettingsRuntimeDto>({
    channel: 'settings.updateLocal',
    description: 'Updates local renderer-safe desktop settings.',
    methodName: 'settingsUpdateLocal',
    namespace: 'settings',
    request: validateSettingsUpdateRequest,
  }),
  defineChannel<EmptyRequest, WorkspaceCapabilitiesDto>({
    channel: 'settings.getCapabilities',
    description: 'Returns provider and runtime capability flags without provider secrets.',
    methodName: 'settingsGetCapabilities',
    namespace: 'settings',
    request: validateEmptyRequest,
  }),
  defineChannel<{ limit?: number }, { entries: DiagnosticsLogEntryDto[] }>({
    channel: 'diagnostics.getSafeLogs',
    description: 'Returns redacted diagnostic log entries.',
    methodName: 'diagnosticsGetSafeLogs',
    namespace: 'diagnostics',
    request: validateOptionalLimitRequest(200),
  }),
  defineChannel<EmptyRequest, DiagnosticsBundleDto>({
    channel: 'diagnostics.exportBundle',
    description: 'Exports a redacted diagnostics bundle descriptor.',
    methodName: 'diagnosticsExportBundle',
    namespace: 'diagnostics',
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

function validateOptionalRedirectRequest(
  payload: unknown,
): RequestValidationResult<{ redirectUri?: string }> {
  if (!isRecord(payload)) {
    return {
      issues: ['request must be an object'],
      ok: false,
    };
  }

  if (payload.redirectUri !== undefined && typeof payload.redirectUri !== 'string') {
    return {
      issues: ['redirectUri must be a string when provided'],
      ok: false,
    };
  }

  return {
    ok: true,
    value: {
      ...(payload.redirectUri ? { redirectUri: payload.redirectUri } : {}),
    },
  };
}

function validateWorkspaceSwitchRequest(
  payload: unknown,
): RequestValidationResult<{ workspaceId: string }> {
  if (!isRecord(payload) || typeof payload.workspaceId !== 'string' || payload.workspaceId === '') {
    return {
      issues: ['workspaceId must be a non-empty string'],
      ok: false,
    };
  }

  return {
    ok: true,
    value: {
      workspaceId: payload.workspaceId,
    },
  };
}

function validateJobRequest(payload: unknown): RequestValidationResult<{ jobId: string }> {
  if (!isRecord(payload) || typeof payload.jobId !== 'string' || payload.jobId === '') {
    return {
      issues: ['jobId must be a non-empty string'],
      ok: false,
    };
  }

  return {
    ok: true,
    value: {
      jobId: payload.jobId,
    },
  };
}

function validateOptionalLimitRequest(max: number) {
  return (payload: unknown): RequestValidationResult<{ limit?: number }> => {
    if (payload === undefined) {
      return {
        ok: true,
        value: {},
      };
    }

    if (!isRecord(payload)) {
      return {
        issues: ['request must be an object'],
        ok: false,
      };
    }

    const limitIssues = validateLimit(payload.limit, max);

    if (limitIssues.length > 0) {
      return {
        issues: limitIssues,
        ok: false,
      };
    }

    const limit = typeof payload.limit === 'number' ? payload.limit : undefined;

    return {
      ok: true,
      value: limit === undefined ? {} : { limit },
    };
  };
}

function validateTimelineQueryRequest(
  payload: unknown,
): RequestValidationResult<TimelineQueryRequestDto> {
  if (!isRecord(payload)) {
    return {
      issues: ['request must be an object'],
      ok: false,
    };
  }

  const issues = [
    ...validateOptionalString(payload.cursor, 'cursor'),
    ...validateLimit(payload.limit, 100),
    ...validateTimelineRange(payload.range),
  ];

  if (issues.length > 0) {
    return {
      issues,
      ok: false,
    };
  }

  const cursor = typeof payload.cursor === 'string' ? payload.cursor : undefined;
  const limit = typeof payload.limit === 'number' ? payload.limit : undefined;
  const range = toTimelineRange(payload.range);

  return {
    ok: true,
    value: {
      ...(cursor ? { cursor } : {}),
      ...(limit === undefined ? {} : { limit }),
      ...(range ? { range } : {}),
    },
  };
}

function validateSearchQueryRequest(
  payload: unknown,
): RequestValidationResult<SearchQueryRequestDto> {
  if (!isRecord(payload)) {
    return {
      issues: ['request must be an object'],
      ok: false,
    };
  }

  const issues = [
    ...(typeof payload.query === 'string' && payload.query.trim().length > 0
      ? []
      : ['query must be a non-empty string']),
    ...validateOptionalString(payload.cursor, 'cursor'),
    ...validateLimit(payload.limit, 50),
  ];

  if (issues.length > 0) {
    return {
      issues,
      ok: false,
    };
  }

  const cursor = typeof payload.cursor === 'string' ? payload.cursor : undefined;
  const limit = typeof payload.limit === 'number' ? payload.limit : undefined;

  return {
    ok: true,
    value: {
      query: (payload.query as string).trim(),
      ...(cursor ? { cursor } : {}),
      ...(limit === undefined ? {} : { limit }),
    },
  };
}

function validateSettingsUpdateRequest(
  payload: unknown,
): RequestValidationResult<Partial<SettingsRuntimeDto>> {
  if (!isRecord(payload)) {
    return {
      issues: ['request must be an object'],
      ok: false,
    };
  }

  const issues = [
    ...collectUnsafeSettingsIssues(payload, []),
    ...validateKnownKeys(payload, ['capture', 'diagnostics'], 'settings'),
    ...validateSettingsCapture(payload.capture),
    ...validateSettingsDiagnostics(payload.diagnostics),
  ];

  if (issues.length > 0) {
    return {
      issues,
      ok: false,
    };
  }

  const value: Partial<SettingsRuntimeDto> = {};

  if (isRecord(payload.capture)) {
    value.capture = {
      ...(typeof payload.capture.enabled === 'boolean' ? { enabled: payload.capture.enabled } : {}),
      ...(isSettingsSchedule(payload.capture.schedule)
        ? { schedule: payload.capture.schedule }
        : {}),
    } as SettingsRuntimeDto['capture'];
  }

  if (isRecord(payload.diagnostics)) {
    value.diagnostics = {
      ...(typeof payload.diagnostics.enabled === 'boolean'
        ? { enabled: payload.diagnostics.enabled }
        : {}),
    } as SettingsRuntimeDto['diagnostics'];
  }

  return {
    ok: true,
    value,
  };
}

function validateSettingsCapture(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }

  if (!isRecord(value)) {
    return ['capture must be an object when provided'];
  }

  return [
    ...validateKnownKeys(value, ['enabled', 'schedule'], 'capture'),
    ...(value.enabled === undefined || typeof value.enabled === 'boolean'
      ? []
      : ['capture.enabled must be a boolean when provided']),
    ...(value.schedule === undefined || isSettingsSchedule(value.schedule)
      ? []
      : ['capture.schedule must be disabled or available when provided']),
  ];
}

function validateSettingsDiagnostics(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }

  if (!isRecord(value)) {
    return ['diagnostics must be an object when provided'];
  }

  return [
    ...validateKnownKeys(value, ['enabled'], 'diagnostics'),
    ...(value.enabled === undefined || typeof value.enabled === 'boolean'
      ? []
      : ['diagnostics.enabled must be a boolean when provided']),
  ];
}

function isSettingsSchedule(value: unknown): value is SettingsRuntimeDto['capture']['schedule'] {
  return value === 'disabled' || value === 'available';
}

function validateKnownKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
): string[] {
  const allowed = new Set(allowedKeys);

  return Object.keys(value)
    .filter((key) => !allowed.has(key))
    .map((key) => `${label}.${key} is not allowed`);
}

const UNSAFE_SETTINGS_FIELD_PATTERN =
  /(token|secret|password|credential|apiKey|api_key|refreshToken|refresh_token|path|rawPayload|helperRawPayload|helperPipe|sqlite|child_process|^fs$)/i;
const LOCAL_ABSOLUTE_PATH_PATTERN = /^(\/Users\/|\/private\/|\/var\/|[A-Za-z]:[\\/])/;
const SECRET_QUERY_KEY_PATTERN =
  /^(token|auth|access_token|refresh_token|secret|password|credential|api[_-]?key)$/i;
const API_KEY_VALUE_PATTERN = /\bsk-[A-Za-z0-9_-]{12,}\b/;

function collectUnsafeSettingsIssues(value: unknown, path: string[]): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      collectUnsafeSettingsIssues(entry, [...path, String(index)]),
    );
  }

  if (typeof value === 'string') {
    const label = path.join('.') || 'settings';

    if (isUnsafeSettingsString(value)) {
      return [`${label} contains an unsafe value`];
    }

    return [];
  }

  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([key, entry]) => {
    const nextPath = [...path, key];

    if (UNSAFE_SETTINGS_FIELD_PATTERN.test(key)) {
      return [`${nextPath.join('.')} is not renderer-safe`];
    }

    return collectUnsafeSettingsIssues(entry, nextPath);
  });
}

function isUnsafeSettingsString(value: string): boolean {
  if (
    LOCAL_ABSOLUTE_PATH_PATTERN.test(value) ||
    value.startsWith('file://') ||
    API_KEY_VALUE_PATTERN.test(value)
  ) {
    return true;
  }

  try {
    const url = new URL(value);

    for (const key of url.searchParams.keys()) {
      if (SECRET_QUERY_KEY_PATTERN.test(key)) {
        return true;
      }
    }
  } catch {
    return false;
  }

  return false;
}

function validateTimelineRange(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }

  if (!isRecord(value)) {
    return ['range must be an object when provided'];
  }

  return [
    ...validateOptionalString(value.from, 'range.from'),
    ...validateOptionalString(value.to, 'range.to'),
  ];
}

function toTimelineRange(value: unknown): TimelineQueryRequestDto['range'] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    ...(typeof value.from === 'string' ? { from: value.from } : {}),
    ...(typeof value.to === 'string' ? { to: value.to } : {}),
  };
}

function validateLimit(value: unknown, max: number): string[] {
  if (value === undefined) {
    return [];
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    return [`limit must be between 1 and ${max} when provided`];
  }

  return [];
}

function validateOptionalString(value: unknown, fieldName: string): string[] {
  if (value === undefined || typeof value === 'string') {
    return [];
  }

  return [`${fieldName} must be a string when provided`];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
