import { z } from 'zod';
import { AiOcrUsageSchema } from './ai-ocr.js';
import { IdSchema, IsoDateTimeSchema, MetadataSchema } from './common.js';
import { ContentHashSchema } from './storage.js';

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

export const OcrScreenTextBlockSchema = z
  .object({
    id: z.string().min(1).max(128).optional(),
    source: OcrScreenTextBlockSourceSchema,
    text: z.string().min(1),
    readingOrder: z.number().int().nonnegative(),
    kind: OcrScreenTextBlockKindSchema.default('text'),
    // Reserved for a future local Apple Vision OCR pass, the only path that can
    // emit a calibrated per-block confidence. The LLM proxy path never fills
    // it — fabricating a number there would violate the fact/inference boundary.
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
// defaults, matching the current server-side OCR behavior. `qualityFlags`,
// however, are real facts the desktop derives at OCR time (e.g. a truncated
// provider response) and submits, so the server stops synthesizing an empty
// list.
export const OcrResultSubmitRequestSchema = z
  .object({
    workspaceId: IdSchema,
    sourceAssetHash: ContentHashSchema,
    screenText: OcrScreenTextResultSchema,
    model: z.string().min(1).max(256),
    providerName: z.string().min(1).max(120),
    durationMs: z.number().int().nonnegative(),
    usage: AiOcrUsageSchema.optional(),
    qualityFlags: z.array(OcrQualityFlagSchema).default([]),
  })
  .strict();

export const OcrResultSubmitResponseSchema = z
  .object({
    result: OcrResultSummarySchema,
  })
  .strict();

export type OcrScreenTextBlockSource = z.infer<typeof OcrScreenTextBlockSourceSchema>;
export type OcrScreenTextBlockKind = z.infer<typeof OcrScreenTextBlockKindSchema>;
export type OcrQualityFlag = z.infer<typeof OcrQualityFlagSchema>;
export type OcrBoundingBox = z.infer<typeof OcrBoundingBoxSchema>;
export type OcrScreenTextBlock = z.infer<typeof OcrScreenTextBlockSchema>;
export type OcrScreenTextResult = z.infer<typeof OcrScreenTextResultSchema>;
export type OcrLayoutResult = z.infer<typeof OcrLayoutResultSchema>;
export type OcrActivityResult = z.infer<typeof OcrActivityResultSchema>;
export type OcrResult = z.infer<typeof OcrResultSchema>;
export type OcrResultSummary = z.infer<typeof OcrResultSummarySchema>;
export type OcrResultSubmitRequest = z.infer<typeof OcrResultSubmitRequestSchema>;
export type OcrResultSubmitResponse = z.infer<typeof OcrResultSubmitResponseSchema>;
