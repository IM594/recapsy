import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema } from './common';

export const DevAcceptanceCaptureStateSchema = z.enum([
  'starting',
  'running',
  'paused',
  'stopping',
  'stopped',
]);

export const DevAcceptanceCapturePauseReasonSchema = z.enum([
  'user',
  'backpressure',
  'storage',
  'policy',
  'permission',
]);

export const DevAcceptanceAdmissionReasonSchema = z.enum([
  'max_queued_jobs_reached',
  'max_asset_bytes_reached',
  'queue_state_unavailable',
]);

export const DevAcceptanceSafeErrorCodeSchema = z.enum([
  'asset_write_failed',
  'capture_failed',
  'cancelled',
  'helper_start_failed',
  'helper_unavailable',
  'helper_unexpected_exit',
  'input_too_large',
  'offline',
  'permission_missing',
  'permission_revoked',
  'policy_denied',
  'policy_invalid_scope',
  'policy_requires_unavailable_context',
  'policy_stale',
  'policy_unavailable',
  'provider_not_configured',
  'provider_unavailable',
  'quota_exceeded',
  'result_invalid',
  'server_unavailable',
  'unknown',
  'unsupported_format',
  'validation_failed',
  'workspace_required',
]);

export const DevAcceptancePolicyVersionSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]+$/)
  .max(128);

const WorkerCapacitySchema = z
  .object({
    activeWorkers: z.number().int().nonnegative(),
    localMaxWorkers: z.number().int().positive(),
    serverMaxConcurrentOcr: z.number().int().positive(),
  })
  .strict()
  .superRefine((capacity, context) => {
    if (
      capacity.activeWorkers > Math.min(capacity.localMaxWorkers, capacity.serverMaxConcurrentOcr)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Active worker capacity exceeds an effective capacity limit.',
        path: ['activeWorkers'],
      });
    }
  });

export const DevAcceptanceDesktopStatusSchema = z
  .object({
    schemaVersion: z.literal(2),
    runtimeInstanceId: IdSchema,
    workspaceId: IdSchema,
    observedAt: IsoDateTimeSchema,
    acceptedCaptureInputPerMinute: z.number().int().nonnegative(),
    completedPerMinute: z.number().int().nonnegative(),
    processing: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    oldestActiveAgeSeconds: z.number().int().nonnegative().nullable(),
    policyVersion: DevAcceptancePolicyVersionSchema.nullable(),
    safeErrorCode: DevAcceptanceSafeErrorCodeSchema.nullable(),
    workerCapacity: WorkerCapacitySchema,
    capture: z
      .object({
        state: DevAcceptanceCaptureStateSchema,
        paused: z.boolean(),
        pauseReasons: z.array(DevAcceptanceCapturePauseReasonSchema).max(5),
      })
      .strict(),
    admission: z
      .object({
        active: z.boolean(),
        reasons: z.array(DevAcceptanceAdmissionReasonSchema).max(3),
      })
      .strict(),
  })
  .strict();

export const DevAcceptanceDesktopStatusResponseSchema = z.discriminatedUnion('connection', [
  z
    .object({ connection: z.literal('connected'), status: DevAcceptanceDesktopStatusSchema })
    .strict(),
  z.object({ connection: z.literal('disconnected'), status: z.null() }).strict(),
]);

export type DevAcceptanceCaptureState = z.infer<typeof DevAcceptanceCaptureStateSchema>;
export type DevAcceptanceCapturePauseReason = z.infer<typeof DevAcceptanceCapturePauseReasonSchema>;
export type DevAcceptanceAdmissionReason = z.infer<typeof DevAcceptanceAdmissionReasonSchema>;
export type DevAcceptanceSafeErrorCode = z.infer<typeof DevAcceptanceSafeErrorCodeSchema>;
export type DevAcceptanceDesktopStatus = z.infer<typeof DevAcceptanceDesktopStatusSchema>;
export type DevAcceptanceDesktopStatusResponse = z.infer<
  typeof DevAcceptanceDesktopStatusResponseSchema
>;
