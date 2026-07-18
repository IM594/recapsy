import {
  AiOcrResponseSchema,
  CaptureCreateRequestSchema,
  CaptureNextActionSchema,
  type CapturePolicyAction,
  type CapturePolicyRule,
  OcrResultSubmitRequestSchema,
  OcrResultSubmitResponseSchema,
} from '@recapsy/contracts';
import { redactLogPayload } from '../logging/redaction';
import type {
  CaptureCreateInput,
  CaptureCreateResult,
  CaptureDetailResult,
  CapturePoliciesResult,
  RunOcrProxyResult,
  ServerApiClient,
  ServerApiClientOptions,
  ServerApiErrorCode,
  ServerApiErrorShape,
  ServerApiOcrProxyClient,
  ServerApiTransportRequest,
  ServerApiTransportResponse,
  ServerCapabilitiesResult,
  SubmitOcrResultInput,
  SubmitOcrResultResult,
} from './types';

export class ServerApiError extends Error implements ServerApiErrorShape {
  readonly code: ServerApiErrorCode;
  readonly retryable: boolean;
  readonly safeMessage: string;
  readonly status?: number;
  readonly details?: Record<string, unknown>;

  constructor(input: ServerApiErrorShape) {
    const safeMessage = defaultSafeMessage(input.code);
    super(safeMessage);
    this.name = 'ServerApiError';
    this.code = input.code;
    this.retryable = input.retryable;
    this.safeMessage = safeMessage;
    this.status = input.status;
    this.details = input.details
      ? (redactLogPayload(input.details) as Record<string, unknown>)
      : undefined;
  }

  toJSON(): ServerApiErrorShape {
    return {
      code: this.code,
      retryable: this.retryable,
      safeMessage: this.safeMessage,
      ...(this.status ? { status: this.status } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function createServerApiClient(
  options: ServerApiClientOptions,
): ServerApiClient & ServerApiOcrProxyClient {
  const endpoint = normalizeEndpoint(options.endpoint);

  return {
    async getAxAllowlist(workspaceId) {
      const body = await request(options, endpoint, {
        method: 'GET',
        path: '/v1/ax/allowlist',
        query: { workspaceId },
      });
      return toAxAllowlistResult(body);
    },
    async getCapabilities() {
      const body = await request(options, endpoint, {
        method: 'GET',
        path: '/v1/capabilities',
      });
      return toCapabilitiesResult(body);
    },
    async getCapturePolicies(input) {
      const body = await request(options, endpoint, {
        method: 'GET',
        path: '/v1/capture/policies',
        query: compactQuery({
          deviceId: input.deviceId,
          workspaceId: input.workspaceId,
        }),
      });
      return toCapturePoliciesResult(body);
    },
    async getCapture(workspaceId, captureId) {
      const body = await request(options, endpoint, {
        method: 'GET',
        path: `/v1/captures/${captureId}`,
        query: { workspaceId },
      });
      return toCaptureDetailResult(body);
    },
    async createCapture(input) {
      const body = await request(options, endpoint, {
        body: toCaptureCreateBody(input),
        method: 'POST',
        path: '/v1/captures',
      });
      return toCaptureCreateResult(body);
    },
    async runOcrProxy(input): Promise<RunOcrProxyResult> {
      const body = await request(options, endpoint, {
        body: input.bytes,
        headers: {
          'content-type': input.mimeType,
          'idempotency-key': input.operationKey,
        },
        method: 'POST',
        path: '/v1/ai/ocr',
        query: { workspaceId: input.workspaceId },
      });
      const parsed = AiOcrResponseSchema.safeParse(body);

      if (!parsed.success) {
        throw invalidResponse();
      }

      return parsed.data;
    },
    async submitOcrResult(input): Promise<SubmitOcrResultResult> {
      const body = await request(options, endpoint, {
        body: toOcrResultSubmitBody(input),
        method: 'POST',
        path: `/v1/captures/${input.captureId}/ocr-result`,
      });
      const parsed = OcrResultSubmitResponseSchema.safeParse(body);

      if (!parsed.success) {
        throw invalidResponse();
      }

      return parsed.data;
    },
    async querySearch(input) {
      const body = await request(options, endpoint, {
        method: 'GET',
        path: '/v1/search',
        query: compactQuery({
          cursor: input.cursor,
          limit: input.limit?.toString(),
          q: input.query,
          workspaceId: input.workspaceId,
        }),
      });
      const results = readArray(body, 'results');
      const pageInfo = readObject(body, 'pageInfo');

      return {
        incomplete: false,
        items: results.map((entry) => {
          const item = readObject(entry, undefined);
          const snippet = readObject(item, 'snippet');
          return {
            capturedAt: readString(item, 'capturedAt'),
            id: readString(item, 'searchDocumentId'),
            snippet: readString(snippet, 'text'),
            ...(readOptionalNumber(item, 'score') !== undefined
              ? { score: readOptionalNumber(item, 'score') }
              : {}),
            ...(readOptionalString(item, 'appName')
              ? { sourceApp: readOptionalString(item, 'appName') }
              : {}),
            ...(readOptionalString(item, 'windowTitleSafe')
              ? { title: readOptionalString(item, 'windowTitleSafe') }
              : {}),
          };
        }),
        ...(readOptionalString(pageInfo, 'nextCursor')
          ? { nextCursor: readOptionalString(pageInfo, 'nextCursor') }
          : {}),
      };
    },
    async queryTimeline(input) {
      const body = await request(options, endpoint, {
        method: 'GET',
        path: '/v1/timeline',
        query: compactQuery({
          cursor: input.cursor,
          from: input.range?.from,
          limit: input.limit?.toString(),
          to: input.range?.to,
          workspaceId: input.workspaceId,
        }),
      });
      const events = readArray(body, 'events');
      const pageInfo = readObject(body, 'pageInfo');

      return {
        incomplete: false,
        items: events.map((entry) => {
          const event = readObject(entry, undefined);
          const context = readObject(event, 'context');
          return {
            capturedAt: readString(event, 'occurredAt'),
            id: readString(event, 'id'),
            ...(readOptionalString(event, 'ocrJobId')
              ? { ocrJobId: readOptionalString(event, 'ocrJobId') }
              : {}),
            ...(readOptionalString(context, 'appName')
              ? { sourceApp: readOptionalString(context, 'appName') }
              : {}),
            ...(readOptionalString(event, 'semanticSummary')
              ? { snippet: readOptionalString(event, 'semanticSummary') }
              : {}),
            ...((readOptionalString(event, 'semanticTitle') ??
            readOptionalString(context, 'windowTitleSafe'))
              ? {
                  title:
                    readOptionalString(event, 'semanticTitle') ??
                    readOptionalString(context, 'windowTitleSafe'),
                }
              : {}),
          };
        }),
        ...(readOptionalString(pageInfo, 'nextCursor')
          ? { nextCursor: readOptionalString(pageInfo, 'nextCursor') }
          : {}),
      };
    },
  };
}

async function request(
  options: ServerApiClientOptions,
  endpoint: URL,
  input: Omit<ServerApiTransportRequest, 'headers' | 'query' | 'url'> & {
    headers?: Record<string, string>;
    query?: Record<string, string>;
  },
): Promise<unknown> {
  const accessToken = await options.accessTokenProvider.getAccessToken();

  if (!accessToken) {
    throw new ServerApiError({
      code: 'unauthenticated',
      retryable: false,
      safeMessage: 'Authentication is required.',
    });
  }

  const query = input.query ?? {};
  const url = new URL(input.path, endpoint);

  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  let response: ServerApiTransportResponse;
  try {
    response = await options.transport({
      body: input.body,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...input.headers,
      },
      method: input.method,
      path: input.path,
      query,
      url,
    });
  } catch (error) {
    if (error instanceof ServerApiError) {
      throw error;
    }

    throw new ServerApiError({
      code: 'offline',
      retryable: true,
      safeMessage: 'Network is offline or unavailable.',
    });
  }

  if (response.status >= 400) {
    throw toServerApiError(response);
  }

  return response.body ?? {};
}

function toCapabilitiesResult(body: unknown): ServerCapabilitiesResult {
  const features = readObject(body, 'features');
  const providers = readArray(body, 'providers');

  return {
    features: Object.fromEntries(
      Object.entries(features)
        .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
        .map(([key, value]) => [
          key,
          {
            enabled: readBoolean(value, 'enabled'),
            ...(readOptionalString(value, 'reason')
              ? { reason: readOptionalString(value, 'reason') }
              : {}),
          },
        ]),
    ),
    generatedAt: readOptionalString(body, 'generatedAt'),
    providers: providers.map((entry) => {
      const provider = readObject(entry, undefined);
      return {
        enabled: readBoolean(provider, 'enabled'),
        hasSecret: readBoolean(provider, 'hasSecret'),
        service: readString(provider, 'service'),
        ...(readOptionalString(provider, 'model')
          ? { model: readOptionalString(provider, 'model') }
          : {}),
        ...(readOptionalString(provider, 'provider')
          ? { provider: readOptionalString(provider, 'provider') }
          : {}),
        ...(readOptionalString(provider, 'reason')
          ? { reason: readOptionalString(provider, 'reason') }
          : {}),
      };
    }),
    workspaceId: readString(body, 'workspaceId'),
  };
}

function toCapturePoliciesResult(body: unknown): CapturePoliciesResult {
  const capturePolicy = readObject(body, 'capturePolicy');
  const deliveryPolicy = readObject(body, 'deliveryPolicy');
  const policy = readObject(capturePolicy, 'policy');
  const storagePolicy = readObject(body, 'storagePolicy');
  const rules = readArray(policy, 'rules').map(readCapturePolicyRule);

  return {
    axAllowlist: toAxAllowlistResult(readObject(body, 'axAllowlist'), {
      generatedAt: readString(body, 'generatedAt'),
      workspaceId: readString(body, 'workspaceId'),
    }),
    capturePolicy: {
      actionCounts: countPolicyActions(rules),
      axTextUploadEnabled: false,
      defaultAction: readPolicyAction(policy, 'defaultAction'),
      expiresAt: readString(capturePolicy, 'expiresAt'),
      id: readString(capturePolicy, 'id'),
      paused: readBoolean(policy, 'paused'),
      policy: {
        axTextUploadEnabled: false,
        defaultAction: readPolicyAction(policy, 'defaultAction'),
        paused: readBoolean(policy, 'paused'),
        rules,
      },
      rules,
      ttlSeconds: readNumber(capturePolicy, 'ttlSeconds'),
      version: readString(capturePolicy, 'version'),
    },
    deviceId: readOptionalString(body, 'deviceId') ?? null,
    deliveryPolicy: {
      maxConcurrentOcr: readPositiveInteger(deliveryPolicy, 'maxConcurrentOcr', 32),
    },
    generatedAt: readString(body, 'generatedAt'),
    storagePolicy: {
      allowLongTermRemoteOriginal: readBoolean(storagePolicy, 'allowLongTermRemoteOriginal'),
      authoritativeOriginalLocation: 'local_device',
    },
    workspaceId: readString(body, 'workspaceId'),
  };
}

function toAxAllowlistResult(
  body: unknown,
  fallback: { workspaceId: string; generatedAt: string } | null = null,
) {
  return {
    axTextUploadEnabled: false as const,
    enabled: false as const,
    generatedAt: readOptionalString(body, 'generatedAt') ?? fallback?.generatedAt,
    policyVersion: readOptionalString(body, 'policyVersion') ?? null,
    reason: 'ax_text_upload_disabled' as const,
    status: 'disabled' as const,
    workspaceId: readOptionalString(body, 'workspaceId') ?? fallback?.workspaceId ?? '',
  };
}

function toCaptureCreateBody(input: CaptureCreateInput): Record<string, unknown> {
  const canExposeOcrAsset =
    input.privacyDecision.action !== 'block_ocr' &&
    input.privacyDecision.action !== 'block_capture';
  const body = {
    appName: input.appName,
    captureType: input.captureType,
    capturedAt: input.capturedAt,
    contextConfidence: input.contextConfidence ?? 'unknown',
    deviceId: input.deviceId,
    idempotencyKey: input.idempotencyKey,
    localAssets: canExposeOcrAsset
      ? [
          {
            availability: 'available',
            byteSize: input.asset.sizeBytes,
            contentHash: input.asset.hash,
            localDeviceAssetRef: input.asset.assetRefId,
            mimeType: input.asset.mimeType,
            role: 'ocr_input_image',
          },
        ]
      : [],
    metadata: input.metadata ?? {},
    observedAt: input.observedAt,
    privacyDecision: input.privacyDecision,
    workspaceId: input.workspaceId,
    ...(input.bundleId ? { bundleId: input.bundleId } : {}),
    ...(input.contextFingerprint ? { contextFingerprint: input.contextFingerprint } : {}),
    ...(input.documentPathCandidate ? { documentPathCandidate: input.documentPathCandidate } : {}),
    ...(input.localEventId ? { localEventId: input.localEventId } : {}),
    ...(input.urlCandidate ? { urlCandidate: input.urlCandidate } : {}),
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.windowTitleCandidate ? { windowTitleCandidate: input.windowTitleCandidate } : {}),
  };
  const parsed = CaptureCreateRequestSchema.safeParse(body);

  if (!parsed.success) {
    throw new ServerApiError({
      code: 'validation_failed',
      details: redactLogPayload(parsed.error.flatten()),
      retryable: false,
      safeMessage: 'Capture creation payload does not match the public contract.',
    });
  }

  return parsed.data;
}

function toOcrResultSubmitBody(input: SubmitOcrResultInput): Record<string, unknown> {
  const body = {
    durationMs: input.durationMs,
    model: input.model,
    providerName: input.providerName,
    screenText: input.screenText,
    sourceAssetHash: input.sourceAssetHash,
    workspaceId: input.workspaceId,
    ...(input.usage ? { usage: input.usage } : {}),
  };
  const parsed = OcrResultSubmitRequestSchema.safeParse(body);

  if (!parsed.success) {
    throw new ServerApiError({
      code: 'validation_failed',
      details: redactLogPayload(parsed.error.flatten()),
      retryable: false,
      safeMessage: 'OCR result submission payload does not match the public contract.',
    });
  }

  return parsed.data;
}

function toCaptureCreateResult(body: unknown): CaptureCreateResult {
  const capture = readObject(readObject(body, 'capture'), undefined);
  const timelineEvent = readObject(readObject(body, 'timelineEvent'), undefined);
  const nextAction = CaptureNextActionSchema.safeParse(readString(body, 'nextAction'));
  const inputAsset = readArray(body, 'assets')
    .map((entry) => readObject(entry, undefined))
    .find((entry) => readOptionalString(entry, 'role') === 'ocr_input_image');

  if (!nextAction.success) {
    throw invalidResponse();
  }

  return {
    captureId: readString(capture, 'id'),
    ...(inputAsset ? { inputAssetId: readString(inputAsset, 'id') } : {}),
    nextAction: nextAction.data,
    timelineEventId: readString(timelineEvent, 'id'),
  };
}

function toCaptureDetailResult(body: unknown): CaptureDetailResult {
  const capture = readObject(readObject(body, 'capture'), undefined);
  const ocr = readObject(body, 'ocr');

  return {
    captureId: readString(capture, 'id'),
    ocrStatus: readString(ocr, 'status') as CaptureDetailResult['ocrStatus'],
    ...(readOptionalString(ocr, 'jobId') ? { ocrJobId: readOptionalString(ocr, 'jobId') } : {}),
  };
}

function toServerApiError(response: ServerApiTransportResponse): ServerApiError {
  const payload = isRecord(response.body) ? response.body : {};
  const apiError = isRecord(payload.error) ? payload.error : {};
  const code = mapServerErrorCode(readOptionalString(apiError, 'code'), response.status);
  const details = isRecord(apiError.details)
    ? (redactLogPayload(apiError.details) as Record<string, unknown>)
    : undefined;

  return new ServerApiError({
    code,
    details,
    retryable:
      isRetryableCode(code) || (isRetryableStatus(response.status) && isRetryableByStatus(code)),
    safeMessage: defaultSafeMessage(code),
    status: response.status,
  });
}

function normalizeEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  url.search = '';
  return url;
}

function mapServerErrorCode(code: string | undefined, status: number): ServerApiErrorCode {
  if (!code) {
    return isRetryableStatus(status) ? 'server_unavailable' : 'unknown';
  }

  const parts = code.split('.');
  const namespace = parts.length > 1 ? parts[0] : undefined;
  const normalized = parts.at(-1) ?? code;

  if (normalized === 'not_configured') {
    return 'provider_not_configured';
  }

  const mapped = mapNamespacedErrorCode(namespace, normalized);

  if (isKnownServerErrorCode(mapped)) {
    return mapped;
  }

  return isRetryableStatus(status) ? 'server_unavailable' : 'unknown';
}

function mapNamespacedErrorCode(
  namespace: string | undefined,
  normalized: string,
): ServerApiErrorCode | string {
  if (namespace === 'provider') {
    if (normalized === 'auth_failed') {
      return 'provider_auth_failed';
    }

    if (normalized === 'rate_limited') {
      return 'provider_rate_limited';
    }

    if (normalized === 'timeout') {
      return 'provider_timeout';
    }
  }

  // OCR proxy backpressure surfaces as `rate_limit.exceeded`; it is a retryable
  // throttle, not a server outage, so it must not collapse to
  // `server_unavailable`.
  if (namespace === 'rate_limit' && normalized === 'exceeded') {
    return 'provider_rate_limited';
  }

  // `workspace.forbidden` is a policy/authorization block on the workspace: a
  // terminal denial the sync flow treats as blocked, not a retryable failure.
  if (namespace === 'workspace' && normalized === 'forbidden') {
    return 'policy_denied';
  }

  return normalized;
}

function isKnownServerErrorCode(code: string): code is ServerApiErrorCode {
  return [
    'unauthenticated',
    'workspace_required',
    'offline',
    'server_unavailable',
    'policy_denied',
    'quota_exceeded',
    'provider_not_configured',
    'provider_unavailable',
    'provider_auth_failed',
    'provider_rate_limited',
    'provider_timeout',
    'operation_in_progress',
    'operation_conflict',
    'input_too_large',
    'unsupported_format',
    'temporary_location_missing',
    'result_invalid',
    'cleanup_failed',
    'validation_failed',
    'cancelled',
    'unknown',
  ].includes(code);
}

function defaultSafeMessage(code: ServerApiErrorCode): string {
  if (code === 'unauthenticated') {
    return 'Authentication is required.';
  }

  if (code === 'workspace_required') {
    return 'Workspace is required.';
  }

  if (code === 'offline') {
    return 'Network is offline or unavailable.';
  }

  if (code === 'provider_not_configured') {
    return 'Provider is not configured.';
  }

  if (code === 'provider_unavailable') {
    return 'Provider is unavailable.';
  }

  if (code === 'provider_auth_failed') {
    return 'Provider authentication failed.';
  }

  if (code === 'provider_rate_limited') {
    return 'Provider is rate limited.';
  }

  if (code === 'provider_timeout') {
    return 'Provider timed out.';
  }

  if (code === 'operation_in_progress') {
    return 'OCR operation is still processing.';
  }

  if (code === 'operation_conflict') {
    return 'OCR operation key conflicts with this image.';
  }

  if (code === 'server_unavailable') {
    return 'Server is unavailable.';
  }

  if (code === 'policy_denied') {
    return 'Capture policy denied this request.';
  }

  if (code === 'quota_exceeded') {
    return 'Quota has been exceeded.';
  }

  if (code === 'input_too_large') {
    return 'Input is too large.';
  }

  if (code === 'unsupported_format') {
    return 'Input format is unsupported.';
  }

  if (code === 'temporary_location_missing') {
    return 'Temporary OCR input is unavailable.';
  }

  if (code === 'result_invalid') {
    return 'OCR result is invalid.';
  }

  if (code === 'cleanup_failed') {
    return 'OCR cleanup failed.';
  }

  if (code === 'validation_failed') {
    return 'Request validation failed.';
  }

  if (code === 'cancelled') {
    return 'Request was cancelled.';
  }

  return 'Request failed.';
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableCode(code: ServerApiErrorCode): boolean {
  return (
    code === 'offline' ||
    code === 'server_unavailable' ||
    code === 'provider_unavailable' ||
    code === 'provider_rate_limited' ||
    code === 'provider_timeout' ||
    code === 'operation_in_progress'
  );
}

function isRetryableByStatus(code: ServerApiErrorCode): boolean {
  return ![
    'cancelled',
    'cleanup_failed',
    'input_too_large',
    'policy_denied',
    'provider_auth_failed',
    'provider_not_configured',
    'quota_exceeded',
    'result_invalid',
    'temporary_location_missing',
    'unsupported_format',
    'unauthenticated',
    'validation_failed',
    'workspace_required',
  ].includes(code);
}

function compactQuery(input: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => {
      return typeof entry[1] === 'string' && entry[1].length > 0;
    }),
  );
}

function readObject(value: unknown, key: string | undefined): Record<string, unknown> {
  const object = key === undefined ? value : isRecord(value) ? value[key] : undefined;

  if (!isRecord(object)) {
    throw invalidResponse();
  }

  return object;
}

function readArray(value: unknown, key: string): unknown[] {
  if (!isRecord(value) || !Array.isArray(value[key])) {
    throw invalidResponse();
  }

  return value[key];
}

function readString(value: unknown, key: string): string {
  const entry = isRecord(value) ? value[key] : undefined;

  if (typeof entry !== 'string' || entry.length === 0) {
    throw invalidResponse();
  }

  return entry;
}

function readOptionalString(value: unknown, key: string): string | undefined {
  const entry = isRecord(value) ? value[key] : undefined;
  return typeof entry === 'string' && entry.length > 0 ? entry : undefined;
}

function readOptionalNumber(value: unknown, key: string): number | undefined {
  const entry = isRecord(value) ? value[key] : undefined;
  return typeof entry === 'number' ? entry : undefined;
}

function readNumber(value: unknown, key: string): number {
  const entry = isRecord(value) ? value[key] : undefined;

  if (typeof entry !== 'number') {
    throw invalidResponse();
  }

  return entry;
}

function readPositiveInteger(value: unknown, key: string, max: number): number {
  const number = readNumber(value, key);
  if (!Number.isInteger(number) || number < 1 || number > max) {
    throw invalidResponse();
  }
  return number;
}

function readBoolean(value: unknown, key: string): boolean {
  const entry = isRecord(value) ? value[key] : undefined;
  return typeof entry === 'boolean' ? entry : false;
}

function countPolicyActions(
  rules: readonly Pick<CapturePolicyRule, 'action'>[],
): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const rule of rules) {
    const action = rule.action;
    counts[action] = (counts[action] ?? 0) + 1;
  }

  return counts;
}

function readCapturePolicyRule(value: unknown): CapturePolicyRule {
  const rule = readObject(value, undefined);
  const reason = readOptionalString(rule, 'reason');
  return {
    action: readPolicyAction(rule, 'action'),
    enabled: readBoolean(rule, 'enabled'),
    id: readString(rule, 'id'),
    kind: readPolicyRuleKind(rule, 'kind'),
    pattern: readString(rule, 'pattern'),
    scope: readPolicyRuleScope(rule, 'scope'),
    ...(reason ? { reason } : {}),
  };
}

function readPolicyAction(value: unknown, key: string): CapturePolicyAction {
  const action = readString(value, key);
  if (!['allow', 'block_capture', 'redact_context', 'block_ocr'].includes(action)) {
    throw invalidResponse();
  }
  return action as CapturePolicyAction;
}

function readPolicyRuleKind(value: unknown, key: string): CapturePolicyRule['kind'] {
  const kind = readString(value, key);
  if (
    !['pause', 'app_name', 'bundle_id', 'domain', 'document_path', 'window_title'].includes(kind)
  ) {
    throw invalidResponse();
  }
  return kind as CapturePolicyRule['kind'];
}

function readPolicyRuleScope(value: unknown, key: string): CapturePolicyRule['scope'] {
  const scope = readString(value, key);
  if (!['local_user', 'workspace_default'].includes(scope)) {
    throw invalidResponse();
  }
  return scope as CapturePolicyRule['scope'];
}

function invalidResponse(): ServerApiError {
  return new ServerApiError({
    code: 'validation_failed',
    retryable: false,
    safeMessage: 'Server response shape is invalid.',
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export type {
  CaptureDetailResult,
  CaptureCreateInput,
  CaptureCreateResult,
  CapturePoliciesInput,
  CapturePoliciesResult,
  AxAllowlistResult,
  RunOcrProxyInput,
  RunOcrProxyResult,
  SearchQueryInput,
  ServerApiClient,
  ServerApiAccessTokenProvider,
  ServerApiClientOptions,
  ServerApiOcrProxyClient,
  ServerCapabilitiesResult,
  ServerCapabilityFeature,
  ServerApiErrorCode,
  ServerApiErrorShape,
  ServerApiTransport,
  ServerApiTransportRequest,
  ServerApiTransportResponse,
  ServerProviderCapability,
  SubmitOcrResultInput,
  SubmitOcrResultResult,
  TimelineQueryInput,
  TimelineQueryResult,
  SearchQueryResult,
} from './types';
