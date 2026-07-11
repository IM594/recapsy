import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema, MetadataSchema, PageInfoSchema } from './common.js';
import { AssetAvailabilityStatusSchema, ContentHashSchema } from './storage.js';

export const SearchModeSchema = z.enum(['text', 'embedding', 'hybrid']);
export const SearchDocumentBodySourceSchema = z.literal('screen_text_image_ocr');
export const SearchDocumentIndexStatusSchema = z.enum(['pending', 'indexed', 'failed', 'stale']);
export const SearchIndexHealthStatusSchema = z.enum([
  'ready',
  'degraded',
  'unavailable',
  'rebuilding',
]);
export const SearchEmbeddingStatusSchema = z.enum([
  'not_requested',
  'pending',
  'indexed',
  'failed',
]);
export const SearchEmbeddingInputKindSchema = z.enum([
  'none',
  'screen_text_ocr',
  'activity_summary',
]);
export const SearchFallbackReasonSchema = z.enum([
  'embedding_unavailable',
  'hybrid_unavailable',
  'index_degraded',
  'offline_cache',
]);
export const SearchResultOcrStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'blocked',
]);
export const SearchResultSyncStatusSchema = z.enum(['pending', 'syncing', 'synced', 'failed']);

export const SearchDocumentSchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    captureId: IdSchema,
    timelineEventId: IdSchema,
    ocrResultId: IdSchema,
    bodyText: z.string().min(1),
    bodySource: SearchDocumentBodySourceSchema,
    language: z.string().min(2).max(32).nullable().optional(),
    bodyHash: ContentHashSchema,
    indexStatus: SearchDocumentIndexStatusSchema,
    indexedAt: IsoDateTimeSchema.nullable().optional(),
    embeddingStatus: SearchEmbeddingStatusSchema.default('not_requested'),
    embeddingInputKind: SearchEmbeddingInputKindSchema.default('none'),
    embeddingSourceHash: ContentHashSchema.nullable().optional(),
    metadata: MetadataSchema.default({}),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const SearchQueryRequestSchema = z
  .object({
    workspaceId: IdSchema,
    q: z.string().min(1).max(1024),
    mode: SearchModeSchema.default('text'),
    allowFallback: z.boolean().default(true),
    from: IsoDateTimeSchema.optional(),
    to: IsoDateTimeSchema.optional(),
    appName: z.string().min(1).max(256).optional(),
    bundleId: z.string().min(1).max(256).optional(),
    limit: z.number().int().positive().max(50).default(20),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export const SearchGetQuerySchema = z
  .object({
    workspaceId: IdSchema,
    q: z.string().min(1).max(1024),
    limit: z.number().int().positive().max(50).default(20),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export const SearchSnippetSchema = z
  .object({
    text: z.string().min(1).max(2048),
    source: SearchDocumentBodySourceSchema,
  })
  .strict();

export const SearchResultSchema = z
  .object({
    searchDocumentId: IdSchema,
    timelineEventId: IdSchema,
    captureId: IdSchema,
    capturedAt: IsoDateTimeSchema,
    appName: z.string().min(1).max(256),
    bundleId: z.string().min(1).max(256).nullable().optional(),
    windowTitleSafe: z.string().min(1).max(512).nullable().optional(),
    urlSafe: z.string().url().nullable().optional(),
    documentPathSafe: z.string().min(1).max(512).nullable().optional(),
    snippet: SearchSnippetSchema,
    score: z.number().nonnegative(),
    indexStatus: SearchDocumentIndexStatusSchema,
    ocrStatus: SearchResultOcrStatusSchema,
    syncStatus: SearchResultSyncStatusSchema,
    assetAvailability: AssetAvailabilityStatusSchema,
    metadata: MetadataSchema.default({}),
  })
  .strict();

export const SearchResponseSchema = z
  .object({
    workspaceId: IdSchema,
    query: z.string().min(1).max(1024),
    modeRequested: SearchModeSchema,
    modeUsed: SearchModeSchema,
    indexStatus: SearchIndexHealthStatusSchema,
    fallbackReason: SearchFallbackReasonSchema.nullable().optional(),
    results: z.array(SearchResultSchema),
    pageInfo: PageInfoSchema,
    generatedAt: IsoDateTimeSchema,
  })
  .strict();

export const SearchDocumentResponseSchema = z
  .object({
    document: SearchDocumentSchema,
  })
  .strict();

export type SearchMode = z.infer<typeof SearchModeSchema>;
export type SearchDocumentBodySource = z.infer<typeof SearchDocumentBodySourceSchema>;
export type SearchDocumentIndexStatus = z.infer<typeof SearchDocumentIndexStatusSchema>;
export type SearchIndexHealthStatus = z.infer<typeof SearchIndexHealthStatusSchema>;
export type SearchEmbeddingStatus = z.infer<typeof SearchEmbeddingStatusSchema>;
export type SearchEmbeddingInputKind = z.infer<typeof SearchEmbeddingInputKindSchema>;
export type SearchFallbackReason = z.infer<typeof SearchFallbackReasonSchema>;
export type SearchResultOcrStatus = z.infer<typeof SearchResultOcrStatusSchema>;
export type SearchResultSyncStatus = z.infer<typeof SearchResultSyncStatusSchema>;
export type SearchDocument = z.infer<typeof SearchDocumentSchema>;
export type SearchQueryRequest = z.infer<typeof SearchQueryRequestSchema>;
export type SearchGetQuery = z.infer<typeof SearchGetQuerySchema>;
export type SearchSnippet = z.infer<typeof SearchSnippetSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
export type SearchDocumentResponse = z.infer<typeof SearchDocumentResponseSchema>;
