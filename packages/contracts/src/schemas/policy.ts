import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema, MetadataSchema } from './common.js';

export const CapturePolicyActionSchema = z.enum([
  'allow',
  'block_capture',
  'redact_context',
  'block_ocr',
]);
export const CapturePolicyRuleKindSchema = z.enum([
  'pause',
  'app_name',
  'bundle_id',
  'domain',
  'domain_family',
  'document_path',
  'window_title',
]);
export const LocalCapturePolicyRuleKindSchema = z.enum(['bundle_id', 'domain', 'domain_family']);
export const CapturePolicyRuleScopeSchema = z.enum(['local_user', 'workspace_default']);
export const StorageDeleteBehaviorSchema = z.enum(['delete_reference', 'delete_source_when_owned']);
export const StorageQuotaScopeSchema = z.enum(['workspace']);
export const AxAllowlistStatusSchema = z.enum(['disabled']);
const CapturePolicyTextSchema = z
  .string()
  .refine((value) => !value.includes('\u0000'), 'Policy text cannot contain NUL characters.');

export const CapturePolicyRuleSchema = z
  .object({
    id: CapturePolicyTextSchema.min(1).max(128),
    kind: CapturePolicyRuleKindSchema,
    scope: CapturePolicyRuleScopeSchema,
    pattern: CapturePolicyTextSchema.min(1).max(1024),
    action: CapturePolicyActionSchema,
    enabled: z.boolean().default(true),
    reason: z.string().min(1).max(512).nullable().optional(),
  })
  .strict();

export const CapturePrivacyDecisionSchema = z
  .object({
    action: CapturePolicyActionSchema,
    decidedAt: IsoDateTimeSchema,
    policySnapshotId: IdSchema.nullable().optional(),
    policyVersion: z.string().min(1).max(128).nullable().optional(),
    reasons: z.array(z.string().min(1).max(256)).default([]),
  })
  .strict();

export const CaptureDefaultPolicySchema = z
  .object({
    paused: z.boolean().default(false),
    defaultAction: CapturePolicyActionSchema.default('allow'),
    axTextUploadEnabled: z.literal(false).default(false),
    rules: z.array(CapturePolicyRuleSchema).default([]),
  })
  .strict();

export const CapturePolicySnapshotSchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    version: z.string().min(1).max(128),
    deviceId: z.string().min(1).max(256).nullable().optional(),
    policy: CaptureDefaultPolicySchema,
    axAllowlistStatus: AxAllowlistStatusSchema.default('disabled'),
    ttlSeconds: z.number().int().positive(),
    generatedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    metadata: MetadataSchema.default({}),
  })
  .strict();

export const StoragePolicySchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    authoritativeOriginalLocation: z.literal('local_device').default('local_device'),
    allowLongTermRemoteOriginal: z.literal(false).default(false),
    allowLongTermRemoteThumbnail: z.literal(false).default(false),
    allowLongTermRemoteReplica: z.literal(false).default(false),
    deleteBehavior: StorageDeleteBehaviorSchema.default('delete_reference'),
    retentionDays: z.number().int().positive().nullable().optional(),
    quotaScope: StorageQuotaScopeSchema.default('workspace'),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    metadata: MetadataSchema.default({}),
  })
  .strict();

export const StoragePolicyUpdateRequestSchema = z
  .object({
    retentionDays: z.number().int().positive().max(3650).nullable(),
  })
  .strict();

export const CapturePoliciesResponseSchema = z
  .object({
    workspaceId: IdSchema,
    deviceId: z.string().min(1).max(256).nullable().optional(),
    capturePolicy: CapturePolicySnapshotSchema,
    deliveryPolicy: z
      .object({
        maxConcurrentOcr: z.number().int().positive().max(32),
      })
      .strict(),
    storagePolicy: StoragePolicySchema,
    axAllowlist: z
      .object({
        enabled: z.literal(false),
        axTextUploadEnabled: z.literal(false),
        status: AxAllowlistStatusSchema,
        reason: z.literal('ax_text_upload_disabled'),
      })
      .strict(),
    generatedAt: IsoDateTimeSchema,
  })
  .strict();

export const StoragePoliciesResponseSchema = z
  .object({
    workspaceId: IdSchema,
    policies: z.array(StoragePolicySchema),
    generatedAt: IsoDateTimeSchema,
  })
  .strict();

export const AxAllowlistResponseSchema = z
  .object({
    workspaceId: IdSchema,
    enabled: z.literal(false),
    axTextUploadEnabled: z.literal(false),
    status: AxAllowlistStatusSchema,
    reason: z.literal('ax_text_upload_disabled'),
    policyVersion: z.string().min(1).max(128).nullable().optional(),
    generatedAt: IsoDateTimeSchema,
  })
  .strict();

export type CapturePolicyAction = z.infer<typeof CapturePolicyActionSchema>;
export type CapturePolicyRuleKind = z.infer<typeof CapturePolicyRuleKindSchema>;
export type LocalCapturePolicyRuleKind = z.infer<typeof LocalCapturePolicyRuleKindSchema>;
export type CapturePolicyRuleScope = z.infer<typeof CapturePolicyRuleScopeSchema>;
export type StorageDeleteBehavior = z.infer<typeof StorageDeleteBehaviorSchema>;
export type StorageQuotaScope = z.infer<typeof StorageQuotaScopeSchema>;
export type AxAllowlistStatus = z.infer<typeof AxAllowlistStatusSchema>;
export type CapturePolicyRule = z.infer<typeof CapturePolicyRuleSchema>;
export type CapturePrivacyDecision = z.infer<typeof CapturePrivacyDecisionSchema>;
export type CaptureDefaultPolicy = z.infer<typeof CaptureDefaultPolicySchema>;
export type CapturePolicySnapshot = z.infer<typeof CapturePolicySnapshotSchema>;
export type StoragePolicy = z.infer<typeof StoragePolicySchema>;
export type StoragePolicyUpdateRequest = z.infer<typeof StoragePolicyUpdateRequestSchema>;
export type CapturePoliciesResponse = z.infer<typeof CapturePoliciesResponseSchema>;
export type StoragePoliciesResponse = z.infer<typeof StoragePoliciesResponseSchema>;
export type AxAllowlistResponse = z.infer<typeof AxAllowlistResponseSchema>;
