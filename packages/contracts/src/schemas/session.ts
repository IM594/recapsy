import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema, MetadataSchema } from './common.js';

export const SessionUserSchema = z
  .object({
    id: IdSchema,
    email: z.string().email(),
    displayName: z.string().nullable().optional(),
  })
  .strict();

export const SessionWorkspaceSchema = z
  .object({
    id: IdSchema,
    slug: z.string().min(1),
    displayName: z.string().min(1),
    role: z.enum(['owner', 'member']),
  })
  .strict();

export const SessionResponseSchema = z
  .object({
    user: SessionUserSchema,
    workspaces: z.array(SessionWorkspaceSchema),
    activeWorkspaceId: IdSchema.nullable(),
    settings: MetadataSchema.default({}),
    issuedAt: IsoDateTimeSchema,
  })
  .strict();

export type SessionUser = z.infer<typeof SessionUserSchema>;
export type SessionWorkspace = z.infer<typeof SessionWorkspaceSchema>;
export type SessionResponse = z.infer<typeof SessionResponseSchema>;
