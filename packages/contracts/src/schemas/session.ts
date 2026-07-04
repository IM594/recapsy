import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema, MetadataSchema } from './common.js';

export const SessionUserSchema = z.object({
  id: IdSchema,
  email: z.string().email(),
  displayName: z.string().nullable().optional(),
});

export const SessionTenantSchema = z.object({
  id: IdSchema,
  slug: z.string().min(1),
  displayName: z.string().min(1),
  role: z.enum(['owner', 'admin', 'member', 'viewer']),
});

export const SessionResponseSchema = z.object({
  user: SessionUserSchema,
  tenants: z.array(SessionTenantSchema),
  activeTenantId: IdSchema.nullable(),
  settings: MetadataSchema.default({}),
  issuedAt: IsoDateTimeSchema,
});

export type SessionUser = z.infer<typeof SessionUserSchema>;
export type SessionTenant = z.infer<typeof SessionTenantSchema>;
export type SessionResponse = z.infer<typeof SessionResponseSchema>;
