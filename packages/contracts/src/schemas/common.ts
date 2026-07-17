import { z } from 'zod';

export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const IdSchema = z.string().uuid();

export const MetadataSchema = z.record(z.string(), z.unknown());
export const ContextConfidenceSchema = z.enum(['high', 'medium', 'low', 'unknown']);

export const ErrorCategorySchema = z.enum([
  'auth',
  'invite',
  'workspace',
  'subscription',
  'providerSettings',
  'provider',
  'capture',
  'storage',
  'policy',
  'ocr',
  'timeline',
  'search',
  'permission',
  'admin',
  'rateLimit',
  'validation',
  'internal',
]);

export const ApiErrorCodeSchema = z.enum([
  'auth.unauthenticated',
  'auth.invalid_credentials',
  'auth.email_exists',
  'auth.session_expired',
  'auth.session_revoked',
  'auth.refresh_failed',
  'invite.invalid',
  'invite.expired',
  'invite.revoked',
  'invite.exhausted',
  'invite.already_used',
  'workspace.not_found',
  'workspace.forbidden',
  'subscription.no_entitlement',
  'subscription.plan_not_found',
  'subscription.quota_exceeded',
  'subscription.paused',
  'subscription.cancelled',
  'subscription.invalid_transition',
  'providerSettings.not_configured',
  'providerSettings.secret_missing',
  'providerSettings.secret_write_only',
  'providerSettings.invalid_scope',
  'provider.not_configured',
  'provider.auth_failed',
  'provider.rate_limited',
  'provider.timeout',
  'capture.not_found',
  'capture.policy_denied',
  'capture.paused',
  'capture.duplicate',
  'capture.invalid_context',
  'storage.asset_not_found',
  'storage.location_not_found',
  'storage.unsupported_location',
  'storage.cleanup_failed',
  'policy.denied',
  'policy.ax_disabled',
  'ocr.job_not_found',
  'ocr.policy_denied',
  'ocr.quota_exceeded',
  'ocr.provider_not_configured',
  'ocr.provider_auth_failed',
  'ocr.provider_rate_limited',
  'ocr.provider_timeout',
  'ocr.input_too_large',
  'ocr.unsupported_format',
  'ocr.temporary_location_missing',
  'ocr.result_invalid',
  'ocr.cleanup_failed',
  'ocr.operation_conflict',
  'ocr.operation_in_progress',
  'ocr.unknown',
  'timeline.event_not_found',
  'timeline.projection_failed',
  'search.index_unavailable',
  'search.unsupported_mode',
  'search.query_invalid',
  'permission.forbidden',
  'permission.admin_required',
  'admin.bootstrap_locked',
  'rate_limit.exceeded',
  'validation.invalid_input',
  'internal.unexpected',
]);

export const ApiErrorPayloadSchema = z
  .object({
    code: ApiErrorCodeSchema,
    message: z.string().min(1),
    category: ErrorCategorySchema,
    requestId: z.string().min(1).optional(),
    details: MetadataSchema.default({}),
  })
  .strict();

export const ApiErrorSchema = z
  .object({
    error: ApiErrorPayloadSchema,
  })
  .strict();

export const PaginationSchema = z.object({
  limit: z.number().int().positive().max(100).default(50),
  cursor: z.string().optional(),
});

export const PageInfoSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.literal('recapsy-server'),
  version: z.string().optional(),
  uptimeSeconds: z.number().nonnegative().optional(),
});

export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;
export type ContextConfidence = z.infer<typeof ContextConfidenceSchema>;
export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;
export type ApiErrorPayload = z.infer<typeof ApiErrorPayloadSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
export type Pagination = z.infer<typeof PaginationSchema>;
export type PageInfo = z.infer<typeof PageInfoSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
