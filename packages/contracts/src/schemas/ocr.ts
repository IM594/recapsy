import { z } from 'zod';
import { AiOcrUsageSchema } from './ai-ocr.js';
import { IdSchema, IsoDateTimeSchema, MetadataSchema } from './common.js';
import { ContentHashSchema, TemporaryLocationCleanupStatusSchema } from './storage.js';

export const OcrJobStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
]);
export const OcrResultLayerSchema = z.enum(['screen_text', 'layout', 'activity']);
export const OcrErrorCodeSchema = z.enum([
  'policy_denied',
  'quota_exceeded',
  'provider_not_configured',
  'provider_auth_failed',
  'provider_rate_limited',
  'provider_timeout',
  'provider_unavailable',
  'input_too_large',
  'unsupported_format',
  'temporary_location_missing',
  'result_invalid',
  'cleanup_failed',
  'unknown',
]);
export const OcrScreenTextBlockSourceSchema = z.literal('image_ocr');
export const OcrScreenTextBlockKindSchema = z.enum([
  'text',
  'heading',
  'label',
  'table_cell',
  'code',
  'other',
]);
export const OcrQualityFlagSchema = z.enum([
  'low_confidence',
  'partial_capture',
  'blurred',
  'truncated',
  'unsupported_language',
]);

export const OcrBoundingBoxSchema = z
  .object({
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
    width: z.number().positive(),
    height: z.number().positive(),
  })
  .strict();

export const OcrJobSafeErrorSchema = z
  .object({
    code: OcrErrorCodeSchema,
    messageSafe: z.string().min(1).max(1024),
    retryable: z.boolean().default(false),
    retryAfter: IsoDateTimeSchema.nullable().optional(),
  })
  .strict();

export const OcrJobSchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    captureId: IdSchema,
    inputAssetId: IdSchema,
    temporaryLocationId: IdSchema.nullable(),
    providerSettingId: IdSchema.nullable().optional(),
    providerModel: z.string().min(1).max(256).nullable().optional(),
    status: OcrJobStatusSchema,
    requestedLayers: z.array(OcrResultLayerSchema).default(['screen_text', 'layout', 'activity']),
    attempt: z.number().int().nonnegative().default(0),
    maxAttempts: z.number().int().positive().default(3),
    queuedAt: IsoDateTimeSchema,
    startedAt: IsoDateTimeSchema.nullable().optional(),
    finishedAt: IsoDateTimeSchema.nullable().optional(),
    nextRetryAt: IsoDateTimeSchema.nullable().optional(),
    error: OcrJobSafeErrorSchema.nullable().optional(),
    inputByteSize: z.number().int().nonnegative().nullable().optional(),
    durationMs: z.number().int().nonnegative().nullable().optional(),
    cleanupStatus: TemporaryLocationCleanupStatusSchema.default('pending'),
    idempotencyKey: z.string().min(1).max(256).optional(),
    metadata: MetadataSchema.default({}),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const OcrJobCreateRequestSchema = z
  .object({
    workspaceId: IdSchema,
    captureId: IdSchema,
    inputAssetId: IdSchema,
    temporaryLocationId: IdSchema,
    requestedLayers: z.array(OcrResultLayerSchema).default(['screen_text', 'layout', 'activity']),
    providerSettingId: IdSchema.nullable().optional(),
    providerModel: z.string().min(1).max(256).nullable().optional(),
    idempotencyKey: z.string().min(1).max(256),
    metadata: MetadataSchema.default({}),
  })
  .strict();

export const OcrScreenTextBlockSchema = z
  .object({
    id: z.string().min(1).max(128).optional(),
    source: OcrScreenTextBlockSourceSchema,
    text: z.string().min(1),
    readingOrder: z.number().int().nonnegative(),
    kind: OcrScreenTextBlockKindSchema.default('text'),
    confidence: z.number().min(0).max(1).nullable().optional(),
    bbox: OcrBoundingBoxSchema.nullable().optional(),
  })
  .strict();

export const OcrScreenTextResultSchema = z
  .object({
    source: OcrScreenTextBlockSourceSchema,
    blocks: z.array(OcrScreenTextBlockSchema),
    readingOrder: z.literal('top_to_bottom_left_to_right').default('top_to_bottom_left_to_right'),
  })
  .strict();

export const OcrLayoutResultSchema = z
  .object({
    layoutNotes: z.array(z.string().min(1).max(1024)).default([]),
    visualHints: z.array(z.string().min(1).max(1024)).default([]),
    detectedTables: z.number().int().nonnegative().default(0),
    metadata: MetadataSchema.default({}),
  })
  .strict();

export const OcrActivityResultSchema = z
  .object({
    activitySummary: z.string().min(1).max(2048).nullable().optional(),
    entities: z.array(z.string().min(1).max(256)).default([]),
    actionHints: z.array(z.string().min(1).max(512)).default([]),
    embeddingCandidateText: z.string().min(1).max(4096).nullable().optional(),
    metadata: MetadataSchema.default({}),
  })
  .strict();

export const OcrResultSchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    captureId: IdSchema,
    jobId: IdSchema,
    resultVersion: z.number().int().positive(),
    providerSettingId: IdSchema.nullable().optional(),
    sourceAssetHash: ContentHashSchema,
    screenText: OcrScreenTextResultSchema,
    layout: OcrLayoutResultSchema,
    activity: OcrActivityResultSchema,
    searchText: z.string(),
    qualityFlags: z.array(OcrQualityFlagSchema).default([]),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export const OcrResultSummarySchema = z
  .object({
    id: IdSchema,
    resultVersion: z.number().int().positive(),
    sourceAssetHash: ContentHashSchema,
    qualityFlags: z.array(OcrQualityFlagSchema).default([]),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

// Client-submitted OCR result for the thin-proxy flow: the desktop runs the
// proxy call, parses screenText locally, then hands the transcript back for
// server-side persistence and indexing. `captureId` is a path parameter, not a
// body field. Idempotency key is (capture + sourceAssetHash) — no independent
// idempotencyKey and no resultVersion in the request (server derives it).
// layout/activity are never client-supplied; the server synthesizes empty
// defaults, matching the current server-side OCR behavior.
export const OcrResultSubmitRequestSchema = z
  .object({
    workspaceId: IdSchema,
    sourceAssetHash: ContentHashSchema,
    screenText: OcrScreenTextResultSchema,
    model: z.string().min(1).max(256),
    providerName: z.string().min(1).max(120),
    durationMs: z.number().int().nonnegative(),
    usage: AiOcrUsageSchema.optional(),
  })
  .strict();

export const OcrResultSubmitResponseSchema = z
  .object({
    result: OcrResultSummarySchema,
  })
  .strict();

export const OcrJobCreateResponseSchema = z
  .object({
    job: OcrJobSchema,
  })
  .strict();

export const OcrJobStatusResponseSchema = z
  .object({
    job: OcrJobSchema,
    resultSummary: OcrResultSummarySchema.nullable().optional(),
  })
  .strict();

export const OcrJobResultResponseSchema = z
  .object({
    job: OcrJobSchema,
    result: OcrResultSchema,
  })
  .strict();

export const OcrJobRetryRequestSchema = z
  .object({
    reason: z.string().min(1).max(512).optional(),
  })
  .strict();

export const OcrJobRetryResponseSchema = z
  .object({
    job: OcrJobSchema,
    accepted: z.boolean(),
    reason: z.string().min(1).max(512).nullable().optional(),
  })
  .strict();

export const OcrJobCancelRequestSchema = z
  .object({
    reason: z.string().min(1).max(512).optional(),
  })
  .strict();

export const OcrJobCancelResponseSchema = z
  .object({
    job: OcrJobSchema,
    cancelled: z.boolean(),
    cleanupStatus: TemporaryLocationCleanupStatusSchema,
  })
  .strict();

export type OcrJobStatus = z.infer<typeof OcrJobStatusSchema>;
export type OcrResultLayer = z.infer<typeof OcrResultLayerSchema>;
export type OcrErrorCode = z.infer<typeof OcrErrorCodeSchema>;
export type OcrScreenTextBlockSource = z.infer<typeof OcrScreenTextBlockSourceSchema>;
export type OcrScreenTextBlockKind = z.infer<typeof OcrScreenTextBlockKindSchema>;
export type OcrQualityFlag = z.infer<typeof OcrQualityFlagSchema>;
export type OcrBoundingBox = z.infer<typeof OcrBoundingBoxSchema>;
export type OcrJobSafeError = z.infer<typeof OcrJobSafeErrorSchema>;
export type OcrJob = z.infer<typeof OcrJobSchema>;
export type OcrJobCreateRequest = z.infer<typeof OcrJobCreateRequestSchema>;
export type OcrScreenTextBlock = z.infer<typeof OcrScreenTextBlockSchema>;
export type OcrScreenTextResult = z.infer<typeof OcrScreenTextResultSchema>;
export type OcrLayoutResult = z.infer<typeof OcrLayoutResultSchema>;
export type OcrActivityResult = z.infer<typeof OcrActivityResultSchema>;
export type OcrResult = z.infer<typeof OcrResultSchema>;
export type OcrResultSummary = z.infer<typeof OcrResultSummarySchema>;
export type OcrResultSubmitRequest = z.infer<typeof OcrResultSubmitRequestSchema>;
export type OcrResultSubmitResponse = z.infer<typeof OcrResultSubmitResponseSchema>;
export type OcrJobCreateResponse = z.infer<typeof OcrJobCreateResponseSchema>;
export type OcrJobStatusResponse = z.infer<typeof OcrJobStatusResponseSchema>;
export type OcrJobResultResponse = z.infer<typeof OcrJobResultResponseSchema>;
export type OcrJobRetryRequest = z.infer<typeof OcrJobRetryRequestSchema>;
export type OcrJobRetryResponse = z.infer<typeof OcrJobRetryResponseSchema>;
export type OcrJobCancelRequest = z.infer<typeof OcrJobCancelRequestSchema>;
export type OcrJobCancelResponse = z.infer<typeof OcrJobCancelResponseSchema>;
