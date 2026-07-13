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
export const AssetLocationKindSchema = z.literal('local_device');
export const AssetLocationAvailabilitySchema = z.enum([
  'pending',
  'available',
  'missing',
  'unavailable',
]);
export const AssetAvailabilityStatusSchema = z.enum([
  'local_device_available',
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

export const AssetLocationSchema = LocalDeviceAssetLocationSchema;

export type ContentHash = z.infer<typeof ContentHashSchema>;
export type PerceptualHash = z.infer<typeof PerceptualHashSchema>;
export type MimeType = z.infer<typeof MimeTypeSchema>;
export type AssetType = z.infer<typeof AssetTypeSchema>;
export type AssetRole = z.infer<typeof AssetRoleSchema>;
export type AssetPrivacyLevel = z.infer<typeof AssetPrivacyLevelSchema>;
export type AssetProcessingStatus = z.infer<typeof AssetProcessingStatusSchema>;
export type AssetLocationKind = z.infer<typeof AssetLocationKindSchema>;
export type AssetLocationAvailability = z.infer<typeof AssetLocationAvailabilitySchema>;
export type AssetAvailabilityStatus = z.infer<typeof AssetAvailabilityStatusSchema>;
export type LocalDeviceAssetRef = z.infer<typeof LocalDeviceAssetRefSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type CaptureAsset = z.infer<typeof CaptureAssetSchema>;
export type LocalDeviceAssetLocation = z.infer<typeof LocalDeviceAssetLocationSchema>;
export type AssetLocation = z.infer<typeof AssetLocationSchema>;
