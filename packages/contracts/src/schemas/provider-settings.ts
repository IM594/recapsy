import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema, MetadataSchema, PageInfoSchema } from './common.js';

export const ProviderServiceSchema = z.enum(['ocr', 'llm', 'embedding']);
export const ProviderSettingScopeTypeSchema = z.enum(['global', 'workspace', 'user']);
export const ProviderSettingStatusSchema = z.enum(['active', 'disabled']);
export const ProviderSecretStatusSchema = z.enum(['missing', 'configured', 'rotating', 'invalid']);
export const ProviderSettingResolutionSourceSchema = z.enum([
  'user',
  'workspace',
  'global',
  'none',
]);

export const ProviderRateLimitSchema = z
  .object({
    requestsPerMinute: z.number().int().positive().nullable().optional(),
    tokensPerMinute: z.number().int().positive().nullable().optional(),
    concurrentRequests: z.number().int().positive().nullable().optional(),
  })
  .strict();

export const ProviderSecretMaskSchema = z
  .object({
    status: ProviderSecretStatusSchema,
    hasSecret: z.boolean(),
    mask: z.string().nullable().optional(),
    last4: z.string().min(1).max(16).nullable().optional(),
    updatedAt: IsoDateTimeSchema.nullable().optional(),
  })
  .strict();

export const ProviderSettingMaskSchema = z
  .object({
    id: IdSchema,
    service: ProviderServiceSchema,
    scopeType: ProviderSettingScopeTypeSchema,
    workspaceId: IdSchema.nullable().optional(),
    userId: IdSchema.nullable().optional(),
    provider: z.string().min(1),
    endpointMask: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    status: ProviderSettingStatusSchema,
    priority: z.number().int().default(0),
    defaultParams: MetadataSchema.default({}),
    rateLimit: ProviderRateLimitSchema.nullable().optional(),
    secretMask: ProviderSecretMaskSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const AdminProviderSettingCreateRequestSchema = z
  .object({
    service: ProviderServiceSchema,
    scopeType: z.literal('global').default('global'),
    provider: z.string().min(1),
    endpoint: z.string().url().nullable().optional(),
    model: z.string().min(1).nullable().optional(),
    status: ProviderSettingStatusSchema.default('active'),
    priority: z.number().int().default(0),
    defaultParams: MetadataSchema.default({}),
    rateLimit: ProviderRateLimitSchema.nullable().optional(),
    secret: z.string().min(1).optional(),
  })
  .strict();

export const AdminProviderSettingUpdateRequestSchema = z
  .object({
    provider: z.string().min(1).optional(),
    endpoint: z.string().url().nullable().optional(),
    model: z.string().min(1).nullable().optional(),
    status: ProviderSettingStatusSchema.optional(),
    priority: z.number().int().optional(),
    defaultParams: MetadataSchema.optional(),
    rateLimit: ProviderRateLimitSchema.nullable().optional(),
    secret: z.string().min(1).optional(),
  })
  .strict();

export const AdminProviderSettingListResponseSchema = z
  .object({
    settings: z.array(ProviderSettingMaskSchema),
    pageInfo: PageInfoSchema,
  })
  .strict();

export const AdminProviderSettingResponseSchema = z
  .object({
    setting: ProviderSettingMaskSchema,
  })
  .strict();

export const AdminProviderModelsResponseSchema = z
  .object({
    settingId: IdSchema,
    provider: z.string().min(1),
    endpointMask: z.string().nullable().optional(),
    models: z.array(z.string().min(1)),
    fetchedAt: IsoDateTimeSchema,
  })
  .strict();

export const EffectiveProviderSettingSchema = z
  .object({
    service: ProviderServiceSchema,
    resolvedFrom: ProviderSettingResolutionSourceSchema,
    setting: ProviderSettingMaskSchema.nullable(),
  })
  .strict();

export const ResolvedProviderSettingsSchema = z
  .object({
    workspaceId: IdSchema,
    userId: IdSchema.optional(),
    resolutionOrder: z.tuple([z.literal('user'), z.literal('workspace'), z.literal('global')]),
    settings: z.array(EffectiveProviderSettingSchema),
    generatedAt: IsoDateTimeSchema,
  })
  .strict();

export type ProviderService = z.infer<typeof ProviderServiceSchema>;
export type ProviderSettingScopeType = z.infer<typeof ProviderSettingScopeTypeSchema>;
export type ProviderSettingStatus = z.infer<typeof ProviderSettingStatusSchema>;
export type ProviderSecretStatus = z.infer<typeof ProviderSecretStatusSchema>;
export type ProviderSettingResolutionSource = z.infer<typeof ProviderSettingResolutionSourceSchema>;
export type ProviderRateLimit = z.infer<typeof ProviderRateLimitSchema>;
export type ProviderSecretMask = z.infer<typeof ProviderSecretMaskSchema>;
export type ProviderSettingMask = z.infer<typeof ProviderSettingMaskSchema>;
export type AdminProviderSettingCreateRequest = z.infer<
  typeof AdminProviderSettingCreateRequestSchema
>;
export type AdminProviderSettingUpdateRequest = z.infer<
  typeof AdminProviderSettingUpdateRequestSchema
>;
export type AdminProviderSettingListResponse = z.infer<
  typeof AdminProviderSettingListResponseSchema
>;
export type AdminProviderSettingResponse = z.infer<typeof AdminProviderSettingResponseSchema>;
export type AdminProviderModelsResponse = z.infer<typeof AdminProviderModelsResponseSchema>;
export type EffectiveProviderSetting = z.infer<typeof EffectiveProviderSettingSchema>;
export type ResolvedProviderSettings = z.infer<typeof ResolvedProviderSettingsSchema>;
