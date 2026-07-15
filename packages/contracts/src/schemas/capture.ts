import { z } from 'zod';
import {
  ContextConfidenceSchema,
  IdSchema,
  IsoDateTimeSchema,
  MetadataSchema,
  PageInfoSchema,
} from './common.js';
import { CapturePrivacyDecisionSchema } from './policy.js';
import { SearchDocumentBodySourceSchema } from './search.js';
import {
  AssetLocationAvailabilitySchema,
  AssetLocationSchema,
  AssetRoleSchema,
  AssetSchema,
  CaptureAssetSchema,
  ContentHashSchema,
  LocalDeviceAssetRefSchema,
  MimeTypeSchema,
  PerceptualHashSchema,
} from './storage.js';
import { TimelineEventSchema } from './timeline.js';

const forbiddenCaptureMetadataKeys = new Set([
  'accessibilityText',
  'axText',
  'bodyText',
  'messageList',
  'ocrText',
  'pageBody',
  'pageText',
  'selectedText',
]);

const hasForbiddenCaptureMetadataKey = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some(hasForbiddenCaptureMetadataKey);
  }

  if (value && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, nestedValue]) =>
        forbiddenCaptureMetadataKeys.has(key) || hasForbiddenCaptureMetadataKey(nestedValue),
    );
  }

  return false;
};

export const CaptureSourceTypeSchema = z.enum(['screen_capture']);
export const CaptureTypeSchema = z.enum(['screen', 'window']);
export const CaptureStatusSchema = z.enum([
  'observed',
  'policy_checked',
  'asset_written',
  'queued_for_sync',
  'synced_metadata',
  'timeline_projected',
  'ocr_succeeded',
  'search_document_indexed',
  'searchable',
  'skipped',
  'sync_failed',
  'timeline_failed',
  'ocr_failed',
  'index_failed',
  'deleted',
]);
export const CaptureOcrStatusSchema = z.enum([
  'not_requested',
  'queued',
  'running',
  'succeeded',
  'failed',
  'blocked',
]);
export const CaptureIndexStatusSchema = z.enum(['not_indexed', 'pending', 'indexed', 'failed']);
export const CaptureTimelineStatusSchema = z.enum(['pending', 'projected', 'failed']);
export const CaptureSyncStateSchema = z.enum([
  'pending',
  'uploading',
  'synced',
  'retry_wait',
  'failed',
  'blocked',
]);
export const CaptureNextActionSchema = z.enum(['queue_ocr', 'none']);
export const CaptureDuplicateHintStatusSchema = z.enum(['unique', 'candidate', 'duplicate']);

export const CaptureSafeMetadataSchema = MetadataSchema.superRefine((value, context) => {
  if (hasForbiddenCaptureMetadataKey(value)) {
    context.addIssue({
      code: 'custom',
      message: 'Capture metadata must not contain AX, page body, selected text, or OCR text.',
    });
  }
});

export const CaptureWindowTitleCandidateSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('safe'),
      value: z.string().min(1).max(512),
    })
    .strict(),
  z
    .object({
      kind: z.literal('redacted'),
      reason: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal('omitted'),
      reason: z.string().min(1).max(256),
    })
    .strict(),
]);

export const CaptureUrlCandidateSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('safe'),
      normalized: z.string().url().optional(),
      domain: z.string().min(1).max(253).optional(),
      hash: z.string().min(8).max(256).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('redacted'),
      reason: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal('omitted'),
      reason: z.string().min(1).max(256),
    })
    .strict(),
]);

export const CaptureDocumentPathCandidateSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('safe'),
      displayName: z.string().min(1).max(512).optional(),
      hash: z.string().min(8).max(256).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('redacted'),
      reason: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal('omitted'),
      reason: z.string().min(1).max(256),
    })
    .strict(),
]);

export const CaptureLocalAssetRefSchema = z
  .object({
    role: AssetRoleSchema,
    localDeviceAssetRef: LocalDeviceAssetRefSchema,
    mimeType: MimeTypeSchema,
    width: z.number().int().positive().nullable().optional(),
    height: z.number().int().positive().nullable().optional(),
    byteSize: z.number().int().positive().nullable().optional(),
    contentHash: ContentHashSchema,
    perceptualHash: PerceptualHashSchema.nullable().optional(),
    availability: AssetLocationAvailabilitySchema.default('available'),
    stagingManifestId: z.string().min(1).max(256).optional(),
    errorMessageSafe: z.string().min(1).max(512).nullable().optional(),
  })
  .strict();

export const CaptureDuplicateHintSchema = z
  .object({
    status: CaptureDuplicateHintStatusSchema,
    duplicateOfCaptureId: IdSchema.nullable().optional(),
    reason: z.string().min(1).max(256).nullable().optional(),
  })
  .strict();

export const CapturePrivacyHintSchema = z
  .object({
    detected: z.boolean(),
    reason: z.string().min(1).max(256).nullable().optional(),
  })
  .strict();

export const CaptureSchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    userId: IdSchema.nullable().optional(),
    deviceId: z.string().min(1).max(256),
    sourceType: CaptureSourceTypeSchema.default('screen_capture'),
    capturedAt: IsoDateTimeSchema,
    observedAt: IsoDateTimeSchema,
    appName: z.string().min(1).max(256),
    bundleId: z.string().min(1).max(256).nullable().optional(),
    windowTitleSafe: z.string().min(1).max(512).nullable().optional(),
    urlSafe: z.string().url().nullable().optional(),
    documentPathSafe: z.string().min(1).max(512).nullable().optional(),
    contextFingerprint: z.string().min(1).max(512).nullable().optional(),
    contextConfidence: ContextConfidenceSchema.default('unknown'),
    captureType: CaptureTypeSchema,
    privacyDecision: CapturePrivacyDecisionSchema,
    captureStatus: CaptureStatusSchema,
    ocrStatus: CaptureOcrStatusSchema,
    indexStatus: CaptureIndexStatusSchema,
    timelineStatus: CaptureTimelineStatusSchema,
    dedupeKey: z.string().min(1).max(256).nullable().optional(),
    duplicateOfCaptureId: IdSchema.nullable().optional(),
    metadata: CaptureSafeMetadataSchema.default({}),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const CaptureCreateRequestSchema = z
  .object({
    workspaceId: IdSchema,
    userId: IdSchema.nullable().optional(),
    deviceId: z.string().min(1).max(256),
    localEventId: z.string().min(1).max(256).optional(),
    capturedAt: IsoDateTimeSchema,
    observedAt: IsoDateTimeSchema,
    appName: z.string().min(1).max(256),
    bundleId: z.string().min(1).max(256).nullable().optional(),
    windowTitleCandidate: CaptureWindowTitleCandidateSchema.optional(),
    urlCandidate: CaptureUrlCandidateSchema.optional(),
    documentPathCandidate: CaptureDocumentPathCandidateSchema.optional(),
    contextFingerprint: z.string().min(1).max(512).optional(),
    contextConfidence: ContextConfidenceSchema.default('unknown'),
    captureType: CaptureTypeSchema,
    privacyDecision: CapturePrivacyDecisionSchema,
    idempotencyKey: z.string().min(1).max(256),
    localAssets: z.array(CaptureLocalAssetRefSchema).default([]),
    contentHash: ContentHashSchema.nullable().optional(),
    perceptualHash: PerceptualHashSchema.nullable().optional(),
    blankScore: z.number().min(0).max(1).nullable().optional(),
    duplicateHint: CaptureDuplicateHintSchema.nullable().optional(),
    secureOrPrivateHint: CapturePrivacyHintSchema.nullable().optional(),
    metadata: CaptureSafeMetadataSchema.default({}),
  })
  .strict();

export const CaptureOcrStatusSummarySchema = z
  .object({
    status: CaptureOcrStatusSchema,
    jobId: IdSchema.nullable().optional(),
    resultId: IdSchema.nullable().optional(),
    resultVersion: z.number().int().positive().nullable().optional(),
  })
  .strict();

export const CaptureSearchStatusSummarySchema = z
  .object({
    status: CaptureIndexStatusSchema,
    searchDocumentId: IdSchema.nullable().optional(),
    bodySource: SearchDocumentBodySourceSchema.nullable().optional(),
  })
  .strict();

export const CaptureTimelineStatusSummarySchema = z
  .object({
    status: CaptureTimelineStatusSchema,
    timelineEventId: IdSchema.nullable().optional(),
  })
  .strict();

export const CaptureCreateResponseSchema = z
  .object({
    capture: CaptureSchema,
    assets: z.array(AssetSchema),
    captureAssets: z.array(CaptureAssetSchema),
    assetLocations: z.array(AssetLocationSchema),
    timelineEvent: TimelineEventSchema,
    policyResult: CapturePrivacyDecisionSchema,
    nextAction: CaptureNextActionSchema,
    syncState: CaptureSyncStateSchema,
  })
  .strict();

export const CaptureDetailResponseSchema = z
  .object({
    capture: CaptureSchema,
    assets: z.array(AssetSchema),
    captureAssets: z.array(CaptureAssetSchema),
    assetLocations: z.array(AssetLocationSchema),
    timeline: CaptureTimelineStatusSummarySchema,
    search: CaptureSearchStatusSummarySchema,
    ocr: CaptureOcrStatusSummarySchema,
  })
  .strict();

export const CaptureListResponseSchema = z
  .object({
    captures: z.array(CaptureSchema),
    pageInfo: PageInfoSchema,
  })
  .strict();

export type CaptureSourceType = z.infer<typeof CaptureSourceTypeSchema>;
export type CaptureType = z.infer<typeof CaptureTypeSchema>;
export type CaptureStatus = z.infer<typeof CaptureStatusSchema>;
export type CaptureOcrStatus = z.infer<typeof CaptureOcrStatusSchema>;
export type CaptureIndexStatus = z.infer<typeof CaptureIndexStatusSchema>;
export type CaptureTimelineStatus = z.infer<typeof CaptureTimelineStatusSchema>;
export type CaptureSyncState = z.infer<typeof CaptureSyncStateSchema>;
export type CaptureNextAction = z.infer<typeof CaptureNextActionSchema>;
export type CaptureDuplicateHintStatus = z.infer<typeof CaptureDuplicateHintStatusSchema>;
export type CaptureSafeMetadata = z.infer<typeof CaptureSafeMetadataSchema>;
export type CaptureWindowTitleCandidate = z.infer<typeof CaptureWindowTitleCandidateSchema>;
export type CaptureUrlCandidate = z.infer<typeof CaptureUrlCandidateSchema>;
export type CaptureDocumentPathCandidate = z.infer<typeof CaptureDocumentPathCandidateSchema>;
export type CaptureLocalAssetRef = z.infer<typeof CaptureLocalAssetRefSchema>;
export type CaptureDuplicateHint = z.infer<typeof CaptureDuplicateHintSchema>;
export type CapturePrivacyHint = z.infer<typeof CapturePrivacyHintSchema>;
export type Capture = z.infer<typeof CaptureSchema>;
export type CaptureCreateRequest = z.infer<typeof CaptureCreateRequestSchema>;
export type CaptureOcrStatusSummary = z.infer<typeof CaptureOcrStatusSummarySchema>;
export type CaptureSearchStatusSummary = z.infer<typeof CaptureSearchStatusSummarySchema>;
export type CaptureTimelineStatusSummary = z.infer<typeof CaptureTimelineStatusSummarySchema>;
export type CaptureCreateResponse = z.infer<typeof CaptureCreateResponseSchema>;
export type CaptureDetailResponse = z.infer<typeof CaptureDetailResponseSchema>;
export type CaptureListResponse = z.infer<typeof CaptureListResponseSchema>;
