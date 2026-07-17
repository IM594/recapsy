import type {
  AiOcrResponse,
  AiOcrUsage,
  CaptureDefaultPolicy,
  CaptureNextAction,
  CapturePolicyAction,
  CapturePolicyRule,
  OcrResultSubmitResponse,
  OcrScreenTextResult,
} from '@recapsy/contracts';

export type ServerApiAccessTokenProvider = {
  getAccessToken(): Promise<string | null>;
};

export type ServerApiTransportRequest = {
  method: 'GET' | 'POST' | 'PUT';
  path: `/v1/${string}`;
  url: URL;
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: unknown;
};

export type ServerApiTransportResponse = {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
};

export type ServerApiTransport = (
  request: ServerApiTransportRequest,
) => Promise<ServerApiTransportResponse>;

export type ServerApiClientOptions = {
  accessTokenProvider: ServerApiAccessTokenProvider;
  endpoint: string;
  transport: ServerApiTransport;
};

export type ServerApiErrorCode =
  | 'unauthenticated'
  | 'workspace_required'
  | 'offline'
  | 'server_unavailable'
  | 'policy_denied'
  | 'quota_exceeded'
  | 'provider_not_configured'
  | 'provider_unavailable'
  | 'provider_auth_failed'
  | 'provider_rate_limited'
  | 'provider_timeout'
  | 'input_too_large'
  | 'unsupported_format'
  | 'temporary_location_missing'
  | 'result_invalid'
  | 'cleanup_failed'
  | 'validation_failed'
  | 'cancelled'
  | 'unknown';

export type ServerApiErrorShape = {
  code: ServerApiErrorCode;
  safeMessage: string;
  retryable: boolean;
  status?: number;
  details?: Record<string, unknown>;
};

export type CapturePrivacyDecisionInput = {
  action: 'allow' | 'block_capture' | 'redact_context' | 'block_ocr';
  decidedAt: string;
  policyVersion: string;
  reasons: string[];
};

export type CaptureCreateInput = {
  capturedAt: string;
  observedAt: string;
  appName: string;
  captureType: 'screen' | 'window';
  privacyDecision: CapturePrivacyDecisionInput;
  workspaceId: string;
  deviceId: string;
  idempotencyKey: string;
  asset: {
    assetRefId: string;
    hash: string;
    mimeType: string;
    role: 'capture_original' | 'capture_thumbnail' | 'ocr_input' | 'derived_asset';
    sizeBytes: number;
  };
  localEventId?: string;
  userId?: string;
  bundleId?: string;
  windowTitleCandidate?: {
    kind: 'safe' | 'redacted' | 'omitted';
    value?: string;
    reason?: string;
  };
  urlCandidate?: {
    kind: 'safe' | 'redacted' | 'omitted';
    normalized?: string;
    domain?: string;
    hash?: string;
    reason?: string;
  };
  documentPathCandidate?: {
    kind: 'safe' | 'redacted' | 'omitted';
    displayName?: string;
    hash?: string;
    reason?: string;
  };
  contextFingerprint?: string;
  contextConfidence?: 'high' | 'medium' | 'low' | 'unknown';
  metadata?: Record<string, unknown>;
};

export type CaptureCreateResult = {
  captureId: string;
  timelineEventId: string;
  nextAction: CaptureNextAction;
  inputAssetId?: string;
};

export type CaptureOcrStatus =
  | 'not_requested'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'blocked';

export type CaptureDetailResult = {
  captureId: string;
  ocrStatus: CaptureOcrStatus;
  ocrJobId?: string;
};

// Thin-proxy OCR: the desktop runs the provider OCR synchronously through the
// authenticated proxy (`POST /v1/ai/ocr`), then hands the locally parsed
// transcript back for server-side persistence
// (`POST /v1/captures/:captureId/ocr-result`).
export type RunOcrProxyInput = {
  workspaceId: string;
  mimeType: string;
  bytes: Uint8Array;
};

export type RunOcrProxyResult = AiOcrResponse;

export type SubmitOcrResultInput = {
  workspaceId: string;
  captureId: string;
  sourceAssetHash: string;
  screenText: OcrScreenTextResult;
  model: string;
  providerName: string;
  durationMs: number;
  usage?: AiOcrUsage;
};

export type SubmitOcrResultResult = OcrResultSubmitResponse;

export type TimelineQueryInput = {
  workspaceId: string;
  cursor?: string;
  limit?: number;
  range?: {
    from?: string;
    to?: string;
  };
};

export type TimelineQueryItem = {
  id: string;
  capturedAt: string;
  sourceApp?: string;
  title?: string;
  snippet?: string;
  ocrJobId?: string;
};

export type TimelineQueryResult = {
  items: TimelineQueryItem[];
  nextCursor?: string;
  incomplete: boolean;
};

export type SearchQueryInput = {
  workspaceId: string;
  query: string;
  cursor?: string;
  limit?: number;
};

export type SearchQueryItem = {
  id: string;
  capturedAt: string;
  sourceApp?: string;
  title?: string;
  snippet: string;
  score?: number;
};

export type SearchQueryResult = {
  items: SearchQueryItem[];
  nextCursor?: string;
  incomplete: boolean;
};

export type ServerCapabilityFeature = {
  enabled: boolean;
  reason?: string;
};

export type ServerProviderCapability = {
  service: string;
  enabled: boolean;
  provider?: string | null;
  model?: string | null;
  hasSecret: boolean;
  reason?: string;
};

export type ServerCapabilitiesResult = {
  workspaceId: string;
  features: Record<string, ServerCapabilityFeature>;
  providers: ServerProviderCapability[];
  generatedAt?: string;
};

export type CapturePoliciesInput = {
  workspaceId: string;
  deviceId?: string;
};

export type CapturePoliciesResult = {
  workspaceId: string;
  deviceId?: string | null;
  capturePolicy: {
    id: string;
    version: string;
    paused: boolean;
    defaultAction: CapturePolicyAction;
    axTextUploadEnabled: false;
    ttlSeconds: number;
    expiresAt: string;
    actionCounts: Record<string, number>;
    policy: CaptureDefaultPolicy;
    rules: CapturePolicyRule[];
  };
  storagePolicy: {
    authoritativeOriginalLocation: 'local_device';
    allowLongTermRemoteOriginal: boolean;
  };
  axAllowlist: AxAllowlistResult;
  generatedAt: string;
};

export type AxAllowlistResult = {
  workspaceId: string;
  enabled: false;
  axTextUploadEnabled: false;
  status: 'disabled';
  reason: 'ax_text_upload_disabled';
  policyVersion?: string | null;
  generatedAt?: string;
};

export type ServerApiClient = {
  createCapture(input: CaptureCreateInput): Promise<CaptureCreateResult>;
  getCapture(workspaceId: string, captureId: string): Promise<CaptureDetailResult>;
  queryTimeline(input: TimelineQueryInput): Promise<TimelineQueryResult>;
  querySearch(input: SearchQueryInput): Promise<SearchQueryResult>;
  getCapabilities(): Promise<ServerCapabilitiesResult>;
  getCapturePolicies(input: CapturePoliciesInput): Promise<CapturePoliciesResult>;
  getAxAllowlist(workspaceId: string): Promise<AxAllowlistResult>;
};

// OCR thin-proxy capabilities layered onto the concrete client. Kept separate
// from `ServerApiClient` during this additive increment so existing consumers
// of the base interface (notably the sync job executor, whose `SyncServerApi`
// aliases `ServerApiClient`) are not forced to implement methods they do not
// yet call. The worker is rewired onto these in a later increment, at which
// point they fold into the base contract.
export type ServerApiOcrProxyClient = {
  runOcrProxy(input: RunOcrProxyInput): Promise<RunOcrProxyResult>;
  submitOcrResult(input: SubmitOcrResultInput): Promise<SubmitOcrResultResult>;
};
