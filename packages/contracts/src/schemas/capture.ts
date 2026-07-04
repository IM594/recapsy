import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema, MetadataSchema, PageInfoSchema } from './common.js';
import { AssetSchema } from './storage.js';

export const CaptureStatusSchema = z.enum([
  'local_only',
  'queued',
  'processing',
  'ready',
  'failed',
  'deleted',
]);

export const CaptureSyncStateSchema = z.enum(['local', 'pending_upload', 'synced', 'conflicted']);

export const CaptureSchema = z.object({
  id: IdSchema,
  tenantId: IdSchema,
  userId: IdSchema.nullable().optional(),
  clientCaptureId: z.string().min(1),
  sourceDeviceId: z.string().optional(),
  capturedAt: IsoDateTimeSchema,
  sourceType: z.string().min(1).default('screen'),
  sourceApp: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  status: CaptureStatusSchema,
  syncState: CaptureSyncStateSchema,
  ocrText: z.string().nullable().optional(),
  ocrProcessedAt: IsoDateTimeSchema.nullable().optional(),
  metadata: MetadataSchema.default({}),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export const CaptureAssetSchema = z.object({
  captureId: IdSchema,
  assetId: IdSchema,
  role: z.string().min(1).default('primary'),
  sortOrder: z.number().int().default(0),
  asset: AssetSchema.optional(),
});

export const CreateCaptureSchema = z.object({
  tenantId: IdSchema,
  clientCaptureId: z.string().min(1),
  sourceDeviceId: z.string().optional(),
  capturedAt: IsoDateTimeSchema,
  sourceType: z.string().min(1).default('screen'),
  sourceApp: z.string().optional(),
  title: z.string().optional(),
  metadata: MetadataSchema.default({}),
  assetIds: z.array(IdSchema).default([]),
});

export const CaptureListResponseSchema = z.object({
  captures: z.array(CaptureSchema),
  pageInfo: PageInfoSchema,
});

export type CaptureStatus = z.infer<typeof CaptureStatusSchema>;
export type CaptureSyncState = z.infer<typeof CaptureSyncStateSchema>;
export type Capture = z.infer<typeof CaptureSchema>;
export type CaptureAsset = z.infer<typeof CaptureAssetSchema>;
export type CreateCapture = z.infer<typeof CreateCaptureSchema>;
export type CaptureListResponse = z.infer<typeof CaptureListResponseSchema>;
