import { z } from 'zod';
import {
  ContextConfidenceSchema,
  IdSchema,
  IsoDateTimeSchema,
  MetadataSchema,
  PageInfoSchema,
} from './common.js';
import { AssetAvailabilityStatusSchema } from './storage.js';

export const TimelineEventSourceTypeSchema = z.enum(['capture']);
export const TimelineEventKindSchema = z.enum(['capture_observed', 'capture_updated']);
export const TimelineProjectionStatusSchema = z.enum(['pending', 'ready', 'failed']);
export const TimelineOcrStatusSchema = z.enum([
  'not_requested',
  'queued',
  'running',
  'succeeded',
  'failed',
  'blocked',
]);
export const TimelineIndexStatusSchema = z.enum(['not_indexed', 'pending', 'indexed', 'failed']);
export const TimelinePrivacyVisibilitySchema = z.enum([
  'user_visible',
  'diagnostic_only',
  'hidden',
]);

export const TimelineUrlSummarySchema = z
  .object({
    normalized: z.string().url().optional(),
    domain: z.string().min(1).max(253).optional(),
    hash: z.string().min(8).max(256).optional(),
  })
  .strict();

export const TimelineDocumentPathSummarySchema = z
  .object({
    displayName: z.string().min(1).max(512).optional(),
    hash: z.string().min(8).max(256).optional(),
  })
  .strict();

export const TimelineContextSummarySchema = z
  .object({
    appName: z.string().min(1).max(256),
    bundleId: z.string().min(1).max(256).optional(),
    windowTitleSafe: z.string().min(1).max(512).nullable().optional(),
    urlSafe: TimelineUrlSummarySchema.nullable().optional(),
    documentPathSafe: TimelineDocumentPathSummarySchema.nullable().optional(),
    contextFingerprint: z.string().min(1).max(512).optional(),
    contextConfidence: ContextConfidenceSchema.default('unknown'),
  })
  .strict();

export const TimelineEventStatusesSchema = z
  .object({
    timelineStatus: TimelineProjectionStatusSchema,
    ocrStatus: TimelineOcrStatusSchema,
    indexStatus: TimelineIndexStatusSchema,
  })
  .strict();

export const TimelineEventSchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    userId: IdSchema.nullable().optional(),
    deviceId: z.string().min(1).max(256).nullable().optional(),
    sourceType: TimelineEventSourceTypeSchema,
    sourceCaptureId: IdSchema,
    searchDocumentId: IdSchema.nullable().optional(),
    eventKind: TimelineEventKindSchema,
    occurredAt: IsoDateTimeSchema,
    context: TimelineContextSummarySchema,
    statuses: TimelineEventStatusesSchema,
    semanticTitle: z.string().min(1).max(256).nullable().optional(),
    semanticSummary: z.string().min(1).max(2048).nullable().optional(),
    assetAvailability: AssetAvailabilityStatusSchema.default('unknown'),
    privacyVisibility: TimelinePrivacyVisibilitySchema.default('user_visible'),
    metadata: MetadataSchema.default({}),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const TimelineQuerySchema = z
  .object({
    workspaceId: IdSchema,
    from: IsoDateTimeSchema.optional(),
    to: IsoDateTimeSchema.optional(),
    appName: z.string().min(1).max(256).optional(),
    bundleId: z.string().min(1).max(256).optional(),
    ocrStatus: TimelineOcrStatusSchema.optional(),
    indexStatus: TimelineIndexStatusSchema.optional(),
    limit: z.number().int().positive().max(100).default(50),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export const TimelineListResponseSchema = z
  .object({
    workspaceId: IdSchema,
    events: z.array(TimelineEventSchema),
    pageInfo: PageInfoSchema,
    generatedAt: IsoDateTimeSchema,
  })
  .strict();

export const TimelineEventResponseSchema = z
  .object({
    event: TimelineEventSchema,
  })
  .strict();

export type TimelineEventSourceType = z.infer<typeof TimelineEventSourceTypeSchema>;
export type TimelineEventKind = z.infer<typeof TimelineEventKindSchema>;
export type TimelineProjectionStatus = z.infer<typeof TimelineProjectionStatusSchema>;
export type TimelineOcrStatus = z.infer<typeof TimelineOcrStatusSchema>;
export type TimelineIndexStatus = z.infer<typeof TimelineIndexStatusSchema>;
export type TimelinePrivacyVisibility = z.infer<typeof TimelinePrivacyVisibilitySchema>;
export type TimelineUrlSummary = z.infer<typeof TimelineUrlSummarySchema>;
export type TimelineDocumentPathSummary = z.infer<typeof TimelineDocumentPathSummarySchema>;
export type TimelineContextSummary = z.infer<typeof TimelineContextSummarySchema>;
export type TimelineEventStatuses = z.infer<typeof TimelineEventStatusesSchema>;
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;
export type TimelineQuery = z.infer<typeof TimelineQuerySchema>;
export type TimelineListResponse = z.infer<typeof TimelineListResponseSchema>;
export type TimelineEventResponse = z.infer<typeof TimelineEventResponseSchema>;
