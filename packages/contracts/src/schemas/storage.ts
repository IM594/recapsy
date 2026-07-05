import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema, MetadataSchema } from './common.js';

export const ContentHashSchema = z.string().min(8).max(256);
export const PerceptualHashSchema = z.string().min(4).max(256);
export const MimeTypeSchema = z.string().min(1).max(128);

export const AssetTypeSchema = z.enum(['image', 'screenshot', 'thumbnail', 'ocr_input']);
export const AssetRoleSchema = z.enum([
  'screenshot_original',
  'screenshot_thumbnail',
  'ocr_input_image',
]);
export const AssetPrivacyLevelSchema = z.enum(['normal', 'sensitive', 'private']);
export const AssetProcessingStatusSchema = z.enum([
  'created',
  'available',
  'processing',
  'processed',
  'failed',
  'deleted',
]);
export const AssetLocationKindSchema = z.enum(['local_device', 'server_temporary']);
export const AssetLocationAvailabilitySchema = z.enum([
  'pending',
  'available',
  'missing',
  'unavailable',
]);
export const TemporaryLocationCleanupStatusSchema = z.enum([
  'not_required',
  'pending',
  'cleaned',
  'failed',
  'expired',
]);
export const TemporaryUploadPurposeSchema = z.enum(['ocr_input']);
export const TemporaryUploadStatusSchema = z.enum([
  'pending',
  'uploaded',
  'attached',
  'expired',
  'cancelled',
]);
export const AssetAvailabilityStatusSchema = z.enum([
  'local_device_available',
  'temporary_server_available',
  'unavailable',
  'unknown',
]);

export const LocalDeviceAssetRefSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.startsWith('/') && !value.startsWith('file://'), {
    message: 'Local device asset refs must be opaque references, not absolute paths.',
  });

export const AssetSchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    ownerUserId: IdSchema.nullable().optional(),
    type: AssetTypeSchema,
    role: AssetRoleSchema,
    mimeType: MimeTypeSchema,
    byteSize: z.number().int().nonnegative().nullable().optional(),
    width: z.number().int().positive().nullable().optional(),
    height: z.number().int().positive().nullable().optional(),
    contentHash: ContentHashSchema.nullable().optional(),
    perceptualHash: PerceptualHashSchema.nullable().optional(),
    privacyLevel: AssetPrivacyLevelSchema.default('normal'),
    processingStatus: AssetProcessingStatusSchema.default('created'),
    metadata: MetadataSchema.default({}),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const CaptureAssetSchema = z
  .object({
    workspaceId: IdSchema,
    captureId: IdSchema,
    assetId: IdSchema,
    role: AssetRoleSchema,
    sortOrder: z.number().int().default(0),
    primary: z.boolean().default(false),
    asset: AssetSchema.optional(),
    createdAt: IsoDateTimeSchema.optional(),
  })
  .strict();

export const LocalDeviceAssetLocationSchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    assetId: IdSchema,
    kind: z.literal('local_device'),
    deviceId: z.string().min(1).max(256),
    localDeviceAssetRef: LocalDeviceAssetRefSchema,
    contentHash: ContentHashSchema.nullable().optional(),
    availability: AssetLocationAvailabilitySchema.default('available'),
    isAuthoritative: z.literal(true).default(true),
    policySnapshotId: IdSchema.nullable().optional(),
    metadata: MetadataSchema.default({}),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const ServerTemporaryAssetLocationSchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    assetId: IdSchema,
    kind: z.literal('server_temporary'),
    temporaryUploadId: z.string().min(1).max(256),
    uploadReceipt: z.string().min(1).max(512).nullable().optional(),
    availability: AssetLocationAvailabilitySchema.default('pending'),
    isAuthoritative: z.literal(false).default(false),
    isTemporary: z.literal(true).default(true),
    expiresAt: IsoDateTimeSchema,
    cleanupStatus: TemporaryLocationCleanupStatusSchema,
    cleanupAttemptedAt: IsoDateTimeSchema.nullable().optional(),
    policySnapshotId: IdSchema.nullable().optional(),
    metadata: MetadataSchema.default({}),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const AssetLocationSchema = z.discriminatedUnion('kind', [
  LocalDeviceAssetLocationSchema,
  ServerTemporaryAssetLocationSchema,
]);

export const TemporaryUploadCreateRequestSchema = z
  .object({
    workspaceId: IdSchema,
    assetId: IdSchema,
    purpose: TemporaryUploadPurposeSchema.default('ocr_input'),
    mimeType: MimeTypeSchema,
    byteSize: z.number().int().positive(),
    contentHash: ContentHashSchema,
    idempotencyKey: z.string().min(1).max(256).optional(),
    metadata: MetadataSchema.default({}),
  })
  .strict();

export const TemporaryUploadSessionSchema = z
  .object({
    id: z.string().min(1).max(256),
    workspaceId: IdSchema,
    assetId: IdSchema,
    purpose: TemporaryUploadPurposeSchema,
    status: TemporaryUploadStatusSchema,
    expiresAt: IsoDateTimeSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const TemporaryUploadPutInstructionsSchema = z
  .object({
    method: z.literal('PUT'),
    url: z.string().url().optional(),
    uploadReceipt: z.string().min(1).max(512).optional(),
    expiresAt: IsoDateTimeSchema,
  })
  .strict();

export const TemporaryUploadCreateResponseSchema = z
  .object({
    upload: TemporaryUploadSessionSchema,
    assetLocation: ServerTemporaryAssetLocationSchema,
    put: TemporaryUploadPutInstructionsSchema,
  })
  .strict();

export const TemporaryUploadPutResponseSchema = z
  .object({
    upload: TemporaryUploadSessionSchema,
    assetLocation: ServerTemporaryAssetLocationSchema,
    uploadReceipt: z.string().min(1).max(512),
    cleanupRequired: z.literal(true).default(true),
    expiresAt: IsoDateTimeSchema,
  })
  .strict();

export type ContentHash = z.infer<typeof ContentHashSchema>;
export type PerceptualHash = z.infer<typeof PerceptualHashSchema>;
export type MimeType = z.infer<typeof MimeTypeSchema>;
export type AssetType = z.infer<typeof AssetTypeSchema>;
export type AssetRole = z.infer<typeof AssetRoleSchema>;
export type AssetPrivacyLevel = z.infer<typeof AssetPrivacyLevelSchema>;
export type AssetProcessingStatus = z.infer<typeof AssetProcessingStatusSchema>;
export type AssetLocationKind = z.infer<typeof AssetLocationKindSchema>;
export type AssetLocationAvailability = z.infer<typeof AssetLocationAvailabilitySchema>;
export type TemporaryLocationCleanupStatus = z.infer<typeof TemporaryLocationCleanupStatusSchema>;
export type TemporaryUploadPurpose = z.infer<typeof TemporaryUploadPurposeSchema>;
export type TemporaryUploadStatus = z.infer<typeof TemporaryUploadStatusSchema>;
export type AssetAvailabilityStatus = z.infer<typeof AssetAvailabilityStatusSchema>;
export type LocalDeviceAssetRef = z.infer<typeof LocalDeviceAssetRefSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type CaptureAsset = z.infer<typeof CaptureAssetSchema>;
export type LocalDeviceAssetLocation = z.infer<typeof LocalDeviceAssetLocationSchema>;
export type ServerTemporaryAssetLocation = z.infer<typeof ServerTemporaryAssetLocationSchema>;
export type AssetLocation = z.infer<typeof AssetLocationSchema>;
export type TemporaryUploadCreateRequest = z.infer<typeof TemporaryUploadCreateRequestSchema>;
export type TemporaryUploadSession = z.infer<typeof TemporaryUploadSessionSchema>;
export type TemporaryUploadPutInstructions = z.infer<typeof TemporaryUploadPutInstructionsSchema>;
export type TemporaryUploadCreateResponse = z.infer<typeof TemporaryUploadCreateResponseSchema>;
export type TemporaryUploadPutResponse = z.infer<typeof TemporaryUploadPutResponseSchema>;
