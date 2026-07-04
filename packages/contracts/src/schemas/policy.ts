import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema, MetadataSchema } from './common.js';

export const StoragePolicyKindSchema = z.enum([
  'local_first',
  'cloud_sync',
  'temporary_processing',
]);

export const StoragePolicySchema = z.object({
  id: IdSchema,
  tenantId: IdSchema,
  kind: StoragePolicyKindSchema,
  name: z.string().min(1),
  objectStoragePrefix: z.string().nullable().optional(),
  temporaryTtlSeconds: z.number().int().positive().nullable().optional(),
  retainServerCopy: z.boolean().default(false),
  settings: MetadataSchema.default({}),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export type StoragePolicyKind = z.infer<typeof StoragePolicyKindSchema>;
export type StoragePolicy = z.infer<typeof StoragePolicySchema>;
