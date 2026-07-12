import type {
  AiOcrResponse,
  AiOcrUsage,
  OcrResultSubmitResponse,
  OcrScreenTextResult,
} from '@recapsy/contracts';
import type { TokenStore } from '../auth/token-store';
import type { SearchQueryResponseDto, TimelineQueryResponseDto } from '../ipc/dto';
import type { AssetCacheRef, CaptureOutboxPayload } from '../storage/types';

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
  endpoint: string;
  tokenStore: TokenStore;
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

export type CaptureIngestInput = CaptureOutboxPayload & {
  workspaceId: string;
  deviceId: string;
  idempotencyKey: string;
  asset: Pick<AssetCacheRef, 'assetRefId' | 'hash' | 'mimeType' | 'role' | 'sizeBytes'>;
};

export type CaptureIngestResult = {
  captureId: string;
  timelineEventId: string;
  nextAction: 'create_temporary_upload' | 'queue_ocr' | 'none';
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
// transcript back for server-side persistence (`POST
// /v1/captures/:captureId/ocr-result`). Both are additive alongside the legacy
// temporary-upload + async OCR-job methods.
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

export type SearchQueryInput = {
  workspaceId: string;
  query: string;
  cursor?: string;
  limit?: number;
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
    version: string;
    paused: boolean;
    defaultAction: string;
    axTextUploadEnabled: false;
    ttlSeconds: number;
    expiresAt: string;
    actionCounts: Record<string, number>;
  };
  storagePolicy: {
    authoritativeOriginalLocation: 'local_device';
    allowTemporaryServerRead: boolean;
    allowLongTermRemoteOriginal: boolean;
    temporaryTtlSeconds: number;
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
  ingestCapture(input: CaptureIngestInput): Promise<CaptureIngestResult>;
  getCapture(workspaceId: string, captureId: string): Promise<CaptureDetailResult>;
  queryTimeline(input: TimelineQueryInput): Promise<TimelineQueryResponseDto>;
  querySearch(input: SearchQueryInput): Promise<SearchQueryResponseDto>;
  getCapabilities(): Promise<ServerCapabilitiesResult>;
  getCapturePolicies(input: CapturePoliciesInput): Promise<CapturePoliciesResult>;
  getAxAllowlist(workspaceId: string): Promise<AxAllowlistResult>;
};

// OCR thin-proxy capabilities layered onto the concrete client. Kept separate
// from `ServerApiClient` during this additive increment so existing consumers
// of the base interface (notably the sync scheduler, whose `SyncServerApi`
// aliases `ServerApiClient`) are not forced to implement methods they do not
// yet call. The scheduler is rewired onto these in a later increment, at which
// point they fold into the base contract.
export type ServerApiOcrProxyClient = {
  runOcrProxy(input: RunOcrProxyInput): Promise<RunOcrProxyResult>;
  submitOcrResult(input: SubmitOcrResultInput): Promise<SubmitOcrResultResult>;
};
