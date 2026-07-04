import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema, MetadataSchema, PageInfoSchema } from './common.js';
import { PlanSummarySchema } from './subscription.js';

export const InviteStatusSchema = z.enum(['active', 'used', 'revoked', 'expired']);
export const InviteInitialUserRoleSchema = z.enum(['user', 'admin']);

export const InviteSafeUserSummarySchema = z
  .object({
    id: IdSchema,
    email: z.string().email(),
    displayName: z.string().nullable().optional(),
  })
  .strict();

export const InviteSafeWorkspaceSummarySchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
  })
  .strict();

export const InviteRedemptionSnapshotSchema = z
  .object({
    user: InviteSafeUserSummarySchema,
    workspace: InviteSafeWorkspaceSummarySchema,
    plan: PlanSummarySchema.nullable(),
    initialTrialDays: z.number().int().nonnegative().nullable().optional(),
    initialQuota: MetadataSchema.default({}),
    redeemedAt: IsoDateTimeSchema,
  })
  .strict();

export const AdminInviteSchema = z
  .object({
    id: IdSchema,
    codePrefix: z.string().min(1),
    status: InviteStatusSchema,
    singleUse: z.literal(true),
    initialPlan: PlanSummarySchema.nullable(),
    initialUserRole: InviteInitialUserRoleSchema.default('user'),
    initialTrialDays: z.number().int().nonnegative().nullable().optional(),
    initialQuota: MetadataSchema.default({}),
    expiresAt: IsoDateTimeSchema.nullable().optional(),
    note: z.string().nullable().optional(),
    createdBy: InviteSafeUserSummarySchema.nullable().optional(),
    usedBy: InviteSafeUserSummarySchema.nullable().optional(),
    usedWorkspace: InviteSafeWorkspaceSummarySchema.nullable().optional(),
    usedAt: IsoDateTimeSchema.nullable().optional(),
    redemptionSnapshot: InviteRedemptionSnapshotSchema.nullable().optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    revokedAt: IsoDateTimeSchema.nullable().optional(),
  })
  .strict();

export const AdminInviteCreateRequestSchema = z
  .object({
    initialPlanId: IdSchema.nullable().optional(),
    initialTrialDays: z.number().int().nonnegative().nullable().optional(),
    initialQuota: MetadataSchema.default({}),
    expiresAt: IsoDateTimeSchema.nullable().optional(),
    note: z.string().nullable().optional(),
  })
  .strict();

export const AdminInviteListResponseSchema = z
  .object({
    invites: z.array(AdminInviteSchema),
    pageInfo: PageInfoSchema,
  })
  .strict();

export const AdminInviteCreateResponseSchema = z
  .object({
    invite: AdminInviteSchema,
    code: z.string().min(16),
  })
  .strict();

export const AdminInviteResponseSchema = z
  .object({
    invite: AdminInviteSchema,
  })
  .strict();

export const AdminInviteRevokeRequestSchema = z
  .object({
    reason: z.string().min(1).optional(),
  })
  .strict();

export const AdminInviteRevokeResponseSchema = AdminInviteResponseSchema;

export type InviteStatus = z.infer<typeof InviteStatusSchema>;
export type InviteInitialUserRole = z.infer<typeof InviteInitialUserRoleSchema>;
export type InviteSafeUserSummary = z.infer<typeof InviteSafeUserSummarySchema>;
export type InviteSafeWorkspaceSummary = z.infer<typeof InviteSafeWorkspaceSummarySchema>;
export type InviteRedemptionSnapshot = z.infer<typeof InviteRedemptionSnapshotSchema>;
export type AdminInvite = z.infer<typeof AdminInviteSchema>;
export type AdminInviteCreateRequest = z.infer<typeof AdminInviteCreateRequestSchema>;
export type AdminInviteListResponse = z.infer<typeof AdminInviteListResponseSchema>;
export type AdminInviteCreateResponse = z.infer<typeof AdminInviteCreateResponseSchema>;
export type AdminInviteResponse = z.infer<typeof AdminInviteResponseSchema>;
export type AdminInviteRevokeRequest = z.infer<typeof AdminInviteRevokeRequestSchema>;
export type AdminInviteRevokeResponse = z.infer<typeof AdminInviteRevokeResponseSchema>;
