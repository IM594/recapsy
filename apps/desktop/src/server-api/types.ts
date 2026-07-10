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

export type TemporaryUploadInput = {
  workspaceId: string;
  assetId: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  idempotencyKey: string;
};

export type TemporaryUploadResult = {
  uploadId: string;
  temporaryLocationId: string;
};

export type TemporaryByteUploadInput = {
  workspaceId: string;
  assetId: string;
  mimeType: string;
  bytes: Uint8Array;
};

export type TemporaryByteUploadResult = TemporaryUploadResult & {
  uploadReceipt: string;
};

export type OcrJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired';

export type OcrJobSafeErrorCode =
  | 'policy_denied'
  | 'quota_exceeded'
  | 'provider_not_configured'
  | 'provider_auth_failed'
  | 'provider_rate_limited'
  | 'provider_timeout'
  | 'provider_unavailable'
  | 'input_too_large'
  | 'unsupported_format'
  | 'temporary_location_missing'
  | 'result_invalid'
  | 'cleanup_failed'
  | 'unknown';

export type OcrJobSafeError = {
  code: OcrJobSafeErrorCode;
  messageSafe: string;
  retryable: boolean;
  retryAfter?: string | null;
};

export type OcrJobSummary = {
  id: string;
  status: OcrJobStatus;
  error?: OcrJobSafeError | null;
};

export type OcrJobCreateInput = {
  workspaceId: string;
  captureId: string;
  inputAssetId: string;
  temporaryLocationId: string;
  idempotencyKey: string;
};

export type OcrJobCreateResult = {
  job: OcrJobSummary;
};

export type OcrJobStatusResult = {
  job: OcrJobSummary;
};

export type OcrJobCancelResult = {
  job: OcrJobSummary;
  cleanupStatus: 'not_required' | 'pending' | 'cleaned' | 'failed' | 'expired';
};

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
  createTemporaryUpload(input: TemporaryUploadInput): Promise<TemporaryUploadResult>;
  putTemporaryBytes(input: TemporaryByteUploadInput): Promise<TemporaryByteUploadResult>;
  createOcrJob(input: OcrJobCreateInput): Promise<OcrJobCreateResult>;
  pollOcrJob(workspaceId: string, jobId: string): Promise<OcrJobStatusResult>;
  cancelOcrJob(jobId: string, workspaceId: string, reason?: string): Promise<OcrJobCancelResult>;
  queryTimeline(input: TimelineQueryInput): Promise<TimelineQueryResponseDto>;
  querySearch(input: SearchQueryInput): Promise<SearchQueryResponseDto>;
  getCapabilities(): Promise<ServerCapabilitiesResult>;
  getCapturePolicies(input: CapturePoliciesInput): Promise<CapturePoliciesResult>;
  getAxAllowlist(workspaceId: string): Promise<AxAllowlistResult>;
};
