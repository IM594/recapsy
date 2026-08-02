import {
  AiOcrResponseSchema,
  AxAllowlistResponseSchema,
  CLIENT_SENT_AT_HEADER,
  CapabilitiesResponseSchema,
  CaptureCoverageBatchCreateRequestSchema,
  CaptureCoverageBatchCreateResponseSchema,
  CaptureCreateRequestSchema,
  CaptureCreateResponseSchema,
  CaptureDetailResponseSchema,
  CapturePoliciesResponseSchema,
  type CapturePolicyRule,
  DeviceCaptureLivenessResponseSchema,
  DeviceCaptureLivenessUpsertRequestSchema,
  OcrResultSubmitRequestSchema,
  OcrResultSubmitResponseSchema,
  SearchResponseSchema,
  TimelineListResponseSchema,
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
  ServerApiCoverageClient,
  ServerApiErrorCode,
  ServerApiErrorShape,
  ServerApiOcrProxyClient,
  ServerApiTransportRequest,
  ServerApiTransportResponse,
  ServerCapabilitiesResult,
  SubmitCoverageBatchInput,
  SubmitCoverageBatchResult,
  SubmitOcrResultInput,
  SubmitOcrResultResult,
  UpsertLivenessInput,
  UpsertLivenessResult,
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
): ServerApiClient & ServerApiOcrProxyClient & ServerApiCoverageClient {
  const endpoint = normalizeEndpoint(options.endpoint);
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async getAxAllowlist(workspaceId) {
      const body = await request(
        options,
        endpoint,
        {
          method: 'GET',
          path: '/v1/ax/allowlist',
          query: { workspaceId },
        },
        now,
      );
      return toAxAllowlistResult(body);
    },
    async getCapabilities() {
      const body = await request(
        options,
        endpoint,
        {
          method: 'GET',
          path: '/v1/capabilities',
        },
        now,
      );
      return toCapabilitiesResult(body);
    },
    async getCapturePolicies(input) {
      const body = await request(
        options,
        endpoint,
        {
          method: 'GET',
          path: '/v1/capture/policies',
          query: compactQuery({
            deviceId: input.deviceId,
            workspaceId: input.workspaceId,
          }),
        },
        now,
      );
      return toCapturePoliciesResult(body);
    },
    async getCapture(workspaceId, captureId) {
      const body = await request(
        options,
        endpoint,
        {
          method: 'GET',
          path: `/v1/captures/${captureId}`,
          query: { workspaceId },
        },
        now,
      );
      return toCaptureDetailResult(body);
    },
    async createCapture(input) {
      const body = await request(
        options,
        endpoint,
        {
          body: toCaptureCreateBody(input),
          method: 'POST',
          path: '/v1/captures',
        },
        now,
      );
      return toCaptureCreateResult(body);
    },
    async runOcrProxy(input): Promise<RunOcrProxyResult> {
      const body = await request(
        options,
        endpoint,
        {
          body: input.bytes,
          headers: {
            'content-type': input.mimeType,
            'idempotency-key': input.operationKey,
          },
          method: 'POST',
          path: '/v1/ai/ocr',
          query: { workspaceId: input.workspaceId },
        },
        now,
      );
      const parsed = AiOcrResponseSchema.safeParse(body);

      if (!parsed.success) {
        throw invalidResponse();
      }

      return parsed.data;
    },
    async submitOcrResult(input): Promise<SubmitOcrResultResult> {
      const body = await request(
        options,
        endpoint,
        {
          body: toOcrResultSubmitBody(input),
          method: 'POST',
          path: `/v1/captures/${input.captureId}/ocr-result`,
        },
        now,
      );
      const parsed = OcrResultSubmitResponseSchema.safeParse(body);

      if (!parsed.success) {
        throw invalidResponse();
      }

      return parsed.data;
    },
    async submitCoverageBatch(input): Promise<SubmitCoverageBatchResult> {
      const body = await request(
        options,
        endpoint,
        {
          body: toCoverageBatchBody(input),
          method: 'POST',
          path: '/v1/captures/coverage',
        },
        now,
      );
      const parsed = CaptureCoverageBatchCreateResponseSchema.safeParse(body);

      if (!parsed.success) {
        throw invalidResponse();
      }

      return parsed.data;
    },
    async upsertLiveness(input): Promise<UpsertLivenessResult> {
      const body = await request(
        options,
        endpoint,
        {
          body: toLivenessUpsertBody(input),
          method: 'PUT',
          path: `/v1/devices/${input.deviceId}/capture-liveness`,
        },
        now,
      );
      const parsed = DeviceCaptureLivenessResponseSchema.safeParse(body);

      if (!parsed.success) {
        throw invalidResponse();
      }

      return parsed.data;
    },
    async querySearch(input) {
      const body = await request(
        options,
        endpoint,
        {
          method: 'GET',
          path: '/v1/search',
          query: compactQuery({
            cursor: input.cursor,
            limit: input.limit?.toString(),
            q: input.query,
            workspaceId: input.workspaceId,
          }),
        },
        now,
      );
      return toSearchQueryResult(body);
    },
    async queryTimeline(input) {
      const body = await request(
        options,
        endpoint,
        {
          method: 'GET',
          path: '/v1/timeline',
          query: compactQuery({
            cursor: input.cursor,
            from: input.range?.from,
            limit: input.limit?.toString(),
            to: input.range?.to,
            workspaceId: input.workspaceId,
          }),
        },
        now,
      );
      return toTimelineQueryResult(body);
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
  now: () => string,
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
        [CLIENT_SENT_AT_HEADER]: now(),
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
  const parsed = CapabilitiesResponseSchema.safeParse(body);

  if (!parsed.success) {
    throw invalidResponse();
  }

  return parsed.data;
}

function toCapturePoliciesResult(body: unknown): CapturePoliciesResult {
  const parsed = CapturePoliciesResponseSchema.safeParse(body);

  if (!parsed.success) {
    throw invalidResponse();
  }

  const { capturePolicy, deliveryPolicy, deviceId, generatedAt, storagePolicy, workspaceId } =
    parsed.data;
  const { policy } = capturePolicy;

  return {
    axAllowlist: {
      ...parsed.data.axAllowlist,
      generatedAt,
      policyVersion: null,
      workspaceId,
    },
    capturePolicy: {
      actionCounts: countPolicyActions(policy.rules),
      axTextUploadEnabled: policy.axTextUploadEnabled,
      defaultAction: policy.defaultAction,
      expiresAt: capturePolicy.expiresAt,
      id: capturePolicy.id,
      paused: policy.paused,
      policy,
      rules: policy.rules,
      ttlSeconds: capturePolicy.ttlSeconds,
      version: capturePolicy.version,
    },
    deviceId: deviceId ?? null,
    deliveryPolicy,
    generatedAt,
    storagePolicy: {
      allowLongTermRemoteOriginal: storagePolicy.allowLongTermRemoteOriginal,
      authoritativeOriginalLocation: storagePolicy.authoritativeOriginalLocation,
    },
    workspaceId,
  };
}

function toAxAllowlistResult(body: unknown) {
  const parsed = AxAllowlistResponseSchema.safeParse(body);

  if (!parsed.success) {
    throw invalidResponse();
  }

  return parsed.data;
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
    qualityFlags: input.qualityFlags,
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

function toCoverageBatchBody(input: SubmitCoverageBatchInput): Record<string, unknown> {
  const body = {
    segments: input.segments,
    workspaceId: input.workspaceId,
  };
  const parsed = CaptureCoverageBatchCreateRequestSchema.safeParse(body);

  if (!parsed.success) {
    throw new ServerApiError({
      code: 'validation_failed',
      details: redactLogPayload(parsed.error.flatten()),
      retryable: false,
      safeMessage: 'Coverage batch payload does not match the public contract.',
    });
  }

  return parsed.data;
}

function toLivenessUpsertBody(input: UpsertLivenessInput): Record<string, unknown> {
  const body = {
    desiredState: input.desiredState,
    deviceId: input.deviceId,
    lastAliveAt: input.lastAliveAt,
    workspaceId: input.workspaceId,
    ...(input.openCoverageState !== undefined
      ? { openCoverageState: input.openCoverageState }
      : {}),
    ...(input.openCoverageStartedAt !== undefined
      ? { openCoverageStartedAt: input.openCoverageStartedAt }
      : {}),
  };
  const parsed = DeviceCaptureLivenessUpsertRequestSchema.safeParse(body);

  if (!parsed.success) {
    throw new ServerApiError({
      code: 'validation_failed',
      details: redactLogPayload(parsed.error.flatten()),
      retryable: false,
      safeMessage: 'Device liveness payload does not match the public contract.',
    });
  }

  return parsed.data;
}

function toCaptureCreateResult(body: unknown): CaptureCreateResult {
  const parsed = CaptureCreateResponseSchema.safeParse(body);

  if (!parsed.success) {
    throw invalidResponse();
  }

  const inputAsset = parsed.data.assets.find((asset) => asset.role === 'ocr_input_image');

  return {
    captureId: parsed.data.capture.id,
    ...(inputAsset ? { inputAssetId: inputAsset.id } : {}),
    nextAction: parsed.data.nextAction,
    timelineEventId: parsed.data.timelineEvent.id,
  };
}

function toCaptureDetailResult(body: unknown): CaptureDetailResult {
  const parsed = CaptureDetailResponseSchema.safeParse(body);

  if (!parsed.success) {
    throw invalidResponse();
  }

  return {
    captureId: parsed.data.capture.id,
    ocrStatus: parsed.data.ocr.status,
    ...(parsed.data.ocr.jobId ? { ocrJobId: parsed.data.ocr.jobId } : {}),
  };
}

function toSearchQueryResult(body: unknown) {
  const parsed = SearchResponseSchema.safeParse(body);

  if (!parsed.success) {
    throw invalidResponse();
  }

  return {
    incomplete: false,
    items: parsed.data.results.map((result) => ({
      capturedAt: result.capturedAt,
      id: result.searchDocumentId,
      score: result.score,
      snippet: result.snippet.text,
      sourceApp: result.appName,
      ...(result.windowTitleSafe ? { title: result.windowTitleSafe } : {}),
    })),
    ...(parsed.data.pageInfo.nextCursor ? { nextCursor: parsed.data.pageInfo.nextCursor } : {}),
  };
}

function toTimelineQueryResult(body: unknown) {
  const parsed = TimelineListResponseSchema.safeParse(body);

  if (!parsed.success) {
    throw invalidResponse();
  }

  return {
    incomplete: false,
    items: parsed.data.events.map((event) => {
      const title = event.semanticTitle ?? event.context.windowTitleSafe;
      return {
        capturedAt: event.occurredAt,
        id: event.id,
        sourceApp: event.context.appName,
        ...(event.semanticSummary ? { snippet: event.semanticSummary } : {}),
        ...(title ? { title } : {}),
      };
    }),
    ...(parsed.data.pageInfo.nextCursor ? { nextCursor: parsed.data.pageInfo.nextCursor } : {}),
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

  if (namespace === 'ocr' && normalized === 'provider_configuration_invalid') {
    return 'provider_configuration_invalid';
  }

  // OCR proxy in-flight ceiling. Distinct from provider vendor rate limits so
  // local capacity is not halved when the server is simply full.
  if (
    (namespace === 'ocr' && normalized === 'concurrency_limited') ||
    (namespace === 'rate_limit' && normalized === 'exceeded')
  ) {
    return 'ocr_concurrency_limited';
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
    'provider_configuration_invalid',
    'provider_rate_limited',
    'provider_timeout',
    'ocr_concurrency_limited',
    'operation_in_progress',
    'operation_conflict',
    'input_too_large',
    'unsupported_format',
    'result_invalid',
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

  if (code === 'provider_configuration_invalid') {
    return 'Provider configuration is invalid.';
  }

  if (code === 'provider_rate_limited') {
    return 'Provider is rate limited.';
  }

  if (code === 'ocr_concurrency_limited') {
    return 'Too many concurrent OCR requests.';
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

  if (code === 'result_invalid') {
    return 'OCR result is invalid.';
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
    code === 'ocr_concurrency_limited' ||
    code === 'operation_in_progress'
  );
}

function isRetryableByStatus(code: ServerApiErrorCode): boolean {
  return ![
    'cancelled',
    'input_too_large',
    'policy_denied',
    'provider_auth_failed',
    'provider_configuration_invalid',
    'provider_not_configured',
    'quota_exceeded',
    'result_invalid',
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

function readOptionalString(value: unknown, key: string): string | undefined {
  const entry = isRecord(value) ? value[key] : undefined;
  return typeof entry === 'string' && entry.length > 0 ? entry : undefined;
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
