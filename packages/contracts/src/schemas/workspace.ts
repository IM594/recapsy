import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema } from './common.js';

export const WorkspaceTypeSchema = z.enum(['personal', 'team']);
export const WorkspaceStatusSchema = z.enum(['active', 'archived', 'disabled']);
export const WorkspaceMembershipRoleSchema = z.enum(['owner', 'admin', 'member', 'viewer']);
export const WorkspaceMembershipStatusSchema = z.enum(['active', 'removed']);

export const WorkspaceSummarySchema = z
  .object({
    id: IdSchema,
    type: WorkspaceTypeSchema,
    name: z.string().min(1),
    status: WorkspaceStatusSchema,
    ownerUserId: IdSchema.optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const WorkspaceMembershipSchema = z
  .object({
    workspaceId: IdSchema,
    userId: IdSchema,
    role: WorkspaceMembershipRoleSchema,
    status: WorkspaceMembershipStatusSchema,
    joinedAt: IsoDateTimeSchema,
  })
  .strict();

export const CurrentWorkspaceResponseSchema = z
  .object({
    workspace: WorkspaceSummarySchema,
    membership: WorkspaceMembershipSchema,
  })
  .strict();

export type WorkspaceType = z.infer<typeof WorkspaceTypeSchema>;
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;
export type WorkspaceMembershipRole = z.infer<typeof WorkspaceMembershipRoleSchema>;
export type WorkspaceMembershipStatus = z.infer<typeof WorkspaceMembershipStatusSchema>;
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;
export type WorkspaceMembership = z.infer<typeof WorkspaceMembershipSchema>;
export type CurrentWorkspaceResponse = z.infer<typeof CurrentWorkspaceResponseSchema>;
