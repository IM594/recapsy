import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema, MetadataSchema } from './common.js';

export const AssetKindSchema = z.enum(['screenshot', 'image', 'ocr_text', 'attachment']);
export const AssetLocationProviderSchema = z.enum(['device', 'server_temp', 'object_storage']);

export const AssetSchema = z.object({
  id: IdSchema,
  tenantId: IdSchema,
  ownerUserId: IdSchema.nullable().optional(),
  kind: AssetKindSchema,
  contentType: z.string().nullable().optional(),
  byteSize: z.number().int().nonnegative().nullable().optional(),
  sha256: z.string().length(64).nullable().optional(),
  originalFileName: z.string().nullable().optional(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  metadata: MetadataSchema.default({}),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export const AssetLocationSchema = z.object({
  id: IdSchema,
  assetId: IdSchema,
  policyId: IdSchema.nullable().optional(),
  provider: AssetLocationProviderSchema,
  bucket: z.string().nullable().optional(),
  objectKey: z.string().nullable().optional(),
  localUri: z.string().nullable().optional(),
  checksum: z.string().nullable().optional(),
  availableUntil: IsoDateTimeSchema.nullable().optional(),
  metadata: MetadataSchema.default({}),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export const CreateTemporaryUploadSessionSchema = z.object({
  tenantId: IdSchema,
  kind: AssetKindSchema,
  contentType: z.string().min(1),
  expectedByteSize: z.number().int().positive().optional(),
  originalFileName: z.string().optional(),
  metadata: MetadataSchema.default({}),
});

export const TemporaryUploadSessionSchema = z.object({
  id: IdSchema,
  tenantId: IdSchema,
  assetId: IdSchema.nullable().optional(),
  objectKey: z.string().min(1),
  status: z.enum(['pending', 'uploaded', 'attached', 'expired', 'canceled']),
  expiresAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export type AssetKind = z.infer<typeof AssetKindSchema>;
export type AssetLocationProvider = z.infer<typeof AssetLocationProviderSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type AssetLocation = z.infer<typeof AssetLocationSchema>;
export type CreateTemporaryUploadSession = z.infer<typeof CreateTemporaryUploadSessionSchema>;
export type TemporaryUploadSession = z.infer<typeof TemporaryUploadSessionSchema>;
