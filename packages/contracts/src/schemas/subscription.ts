import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema, MetadataSchema, PageInfoSchema } from './common.js';

export const PlanStatusSchema = z.enum(['active', 'archived']);
export const SubscriptionStatusSchema = z.enum([
  'trialing',
  'active',
  'paused',
  'cancelled',
  'expired',
]);
export const SubscriptionSourceSchema = z.enum([
  'invite_initial',
  'admin_manual',
  'payment_provider',
  'enterprise_contract',
]);

export const PlanSummarySchema = z
  .object({
    id: IdSchema,
    code: z.string().min(1),
    name: z.string().min(1),
    status: PlanStatusSchema,
    version: z.number().int().positive(),
  })
  .strict();

export const PlanSchema = PlanSummarySchema.extend({
  features: MetadataSchema.default({}),
  limits: MetadataSchema.default({}),
  retentionPolicy: MetadataSchema.default({}),
  isPublic: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  archivedAt: IsoDateTimeSchema.nullable().optional(),
}).strict();

export const UsageCounterSchema = z
  .object({
    workspaceId: IdSchema,
    periodStart: IsoDateTimeSchema,
    periodEnd: IsoDateTimeSchema,
    usage: MetadataSchema.default({}),
    limits: MetadataSchema.default({}),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const SubscriptionSchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    plan: PlanSummarySchema,
    status: SubscriptionStatusSchema,
    source: SubscriptionSourceSchema,
    currentPeriodStart: IsoDateTimeSchema.nullable().optional(),
    currentPeriodEnd: IsoDateTimeSchema.nullable().optional(),
    trialEndsAt: IsoDateTimeSchema.nullable().optional(),
    startsAt: IsoDateTimeSchema,
    endsAt: IsoDateTimeSchema.nullable().optional(),
    pausedAt: IsoDateTimeSchema.nullable().optional(),
    cancelledAt: IsoDateTimeSchema.nullable().optional(),
    cancelAtPeriodEnd: z.boolean().default(false),
    quotaOverride: MetadataSchema.default({}),
    adminNote: z.string().nullable().optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const SubscriptionEntitlementSnapshotSchema = z
  .object({
    workspaceId: IdSchema,
    subscriptionId: IdSchema.nullable().optional(),
    plan: PlanSummarySchema.nullable(),
    status: SubscriptionStatusSchema,
    features: MetadataSchema.default({}),
    limits: MetadataSchema.default({}),
    usage: MetadataSchema.default({}),
    effectiveAt: IsoDateTimeSchema,
  })
  .strict();

export const AdminPlanCreateRequestSchema = z
  .object({
    code: z.string().min(1),
    name: z.string().min(1),
    features: MetadataSchema.default({}),
    limits: MetadataSchema.default({}),
    retentionPolicy: MetadataSchema.default({}),
    isPublic: z.boolean().default(false),
    sortOrder: z.number().int().default(0),
  })
  .strict();

export const AdminPlanUpdateRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    status: PlanStatusSchema.optional(),
    features: MetadataSchema.optional(),
    limits: MetadataSchema.optional(),
    retentionPolicy: MetadataSchema.optional(),
    isPublic: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

export const AdminPlanListResponseSchema = z
  .object({
    plans: z.array(PlanSchema),
    pageInfo: PageInfoSchema,
  })
  .strict();

export const AdminPlanResponseSchema = z
  .object({
    plan: PlanSchema,
  })
  .strict();

export const AdminSubscriptionCreateRequestSchema = z
  .object({
    workspaceId: IdSchema,
    planId: IdSchema,
    status: SubscriptionStatusSchema.default('active'),
    source: SubscriptionSourceSchema.default('admin_manual'),
    trialEndsAt: IsoDateTimeSchema.nullable().optional(),
    startsAt: IsoDateTimeSchema.optional(),
    endsAt: IsoDateTimeSchema.nullable().optional(),
    currentPeriodStart: IsoDateTimeSchema.nullable().optional(),
    currentPeriodEnd: IsoDateTimeSchema.nullable().optional(),
    quotaOverride: MetadataSchema.default({}),
    adminNote: z.string().nullable().optional(),
  })
  .strict();

export const AdminSubscriptionUpdateRequestSchema = z
  .object({
    planId: IdSchema.optional(),
    status: SubscriptionStatusSchema.optional(),
    trialEndsAt: IsoDateTimeSchema.nullable().optional(),
    endsAt: IsoDateTimeSchema.nullable().optional(),
    currentPeriodStart: IsoDateTimeSchema.nullable().optional(),
    currentPeriodEnd: IsoDateTimeSchema.nullable().optional(),
    quotaOverride: MetadataSchema.optional(),
    adminNote: z.string().nullable().optional(),
  })
  .strict();

export const AdminSubscriptionPauseRequestSchema = z
  .object({
    reason: z.string().min(1).optional(),
    adminNote: z.string().nullable().optional(),
  })
  .strict();

export const AdminSubscriptionResumeRequestSchema = z
  .object({
    adminNote: z.string().nullable().optional(),
  })
  .strict();

export const AdminSubscriptionCancelRequestSchema = z
  .object({
    cancelAtPeriodEnd: z.boolean().default(false),
    reason: z.string().min(1).optional(),
    adminNote: z.string().nullable().optional(),
  })
  .strict();

export const AdminSubscriptionListResponseSchema = z
  .object({
    subscriptions: z.array(SubscriptionSchema),
    pageInfo: PageInfoSchema,
  })
  .strict();

export const AdminSubscriptionResponseSchema = z
  .object({
    subscription: SubscriptionSchema,
    entitlement: SubscriptionEntitlementSnapshotSchema,
  })
  .strict();

export const AdminSubscriptionUsageResponseSchema = z
  .object({
    subscription: SubscriptionSchema,
    usage: UsageCounterSchema,
  })
  .strict();

export type PlanStatus = z.infer<typeof PlanStatusSchema>;
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;
export type SubscriptionSource = z.infer<typeof SubscriptionSourceSchema>;
export type PlanSummary = z.infer<typeof PlanSummarySchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type UsageCounter = z.infer<typeof UsageCounterSchema>;
export type Subscription = z.infer<typeof SubscriptionSchema>;
export type SubscriptionEntitlementSnapshot = z.infer<typeof SubscriptionEntitlementSnapshotSchema>;
export type AdminPlanCreateRequest = z.infer<typeof AdminPlanCreateRequestSchema>;
export type AdminPlanUpdateRequest = z.infer<typeof AdminPlanUpdateRequestSchema>;
export type AdminPlanListResponse = z.infer<typeof AdminPlanListResponseSchema>;
export type AdminPlanResponse = z.infer<typeof AdminPlanResponseSchema>;
export type AdminSubscriptionCreateRequest = z.infer<typeof AdminSubscriptionCreateRequestSchema>;
export type AdminSubscriptionUpdateRequest = z.infer<typeof AdminSubscriptionUpdateRequestSchema>;
export type AdminSubscriptionPauseRequest = z.infer<typeof AdminSubscriptionPauseRequestSchema>;
export type AdminSubscriptionResumeRequest = z.infer<typeof AdminSubscriptionResumeRequestSchema>;
export type AdminSubscriptionCancelRequest = z.infer<typeof AdminSubscriptionCancelRequestSchema>;
export type AdminSubscriptionListResponse = z.infer<typeof AdminSubscriptionListResponseSchema>;
export type AdminSubscriptionResponse = z.infer<typeof AdminSubscriptionResponseSchema>;
export type AdminSubscriptionUsageResponse = z.infer<typeof AdminSubscriptionUsageResponseSchema>;
