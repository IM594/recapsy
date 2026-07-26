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
  'asset_write_failed',
  'max_queued_jobs_reached',
  'max_asset_bytes_reached',
  'max_retrying_jobs_reached',
  'min_available_storage_reached',
  'queue_state_unavailable',
  'storage_state_unavailable',
]);

export const DevAcceptanceSafeErrorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/)
  .max(64);

export const DevAcceptancePolicyVersionSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]+$/)
  .max(128);

/** Local outbox lifecycle stage projected for the acceptance console. */
export const DevAcceptanceLocalStageSchema = z.enum([
  'queued',
  'retry_wait',
  'creating_capture',
  'running_ocr',
  'submitting_result',
  'synced',
  'failed',
  'blocked',
  'cancelled',
]);

export const DevAcceptanceJobIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9._:-]+$/);

/** App label for debug UX only — rejects path-like values. */
export const DevAcceptanceAppNameSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (value) => {
      if (/[\\/]/.test(value)) return false;
      for (let index = 0; index < value.length; index += 1) {
        if (value.charCodeAt(index) < 32) return false;
      }
      return true;
    },
    {
      message: 'App name must not look like a path or contain control characters.',
    },
  );

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

export const DevAcceptanceSyncGateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('open') }).strict(),
  z
    .object({
      state: z.literal('paused'),
      reason: z.literal('provider_auth_failed'),
      pausedAt: IsoDateTimeSchema,
      nextProbeAt: IsoDateTimeSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal('half_open'),
      reason: z.literal('provider_auth_failed'),
      pausedAt: IsoDateTimeSchema,
      nextProbeAt: IsoDateTimeSchema,
    })
    .strict(),
]);

const QueueCountsSchema = z
  .object({
    pending: z.number().int().nonnegative(),
    syncing: z.number().int().nonnegative(),
    resultPending: z.number().int().nonnegative(),
    retrying: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
  })
  .strict();

const JobSummarySchema = z
  .object({
    localJobId: DevAcceptanceJobIdSchema,
    serverCaptureId: IdSchema.nullable(),
    appName: DevAcceptanceAppNameSchema.nullable(),
    localStage: DevAcceptanceLocalStageSchema,
    attempt: z.number().int().nonnegative(),
    ageSeconds: z.number().int().nonnegative(),
    safeErrorCode: DevAcceptanceSafeErrorCodeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    nextRetryAt: IsoDateTimeSchema.nullable(),
  })
  .strict();

export const DevAcceptanceDesktopStatusSchema = z
  .object({
    schemaVersion: z.literal(3),
    runtimeInstanceId: IdSchema,
    workspaceId: IdSchema,
    observedAt: IsoDateTimeSchema,
    acceptedCaptureInputPerMinute: z.number().int().nonnegative(),
    completedPerMinute: z.number().int().nonnegative(),
    /** syncing + result_pending — kept for overall throughput badges. */
    processing: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    oldestActiveAgeSeconds: z.number().int().nonnegative().nullable(),
    policyVersion: DevAcceptancePolicyVersionSchema.nullable(),
    safeErrorCode: DevAcceptanceSafeErrorCodeSchema.nullable(),
    workerCapacity: WorkerCapacitySchema,
    syncGate: DevAcceptanceSyncGateSchema,
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
        reasons: z.array(DevAcceptanceAdmissionReasonSchema).max(7),
      })
      .strict(),
    queue: QueueCountsSchema,
    /** Currently executing jobs (syncing / result_pending), oldest first. */
    inFlight: z.array(JobSummarySchema).max(8),
    /** Queue heads: pending / retrying / failed / blocked, newest activity first. */
    queueHeads: z.array(JobSummarySchema).max(24),
  })
  .strict();

export const DevAcceptanceDesktopStatusResponseSchema = z.discriminatedUnion('connection', [
  z
    .object({ connection: z.literal('connected'), status: DevAcceptanceDesktopStatusSchema })
    .strict(),
  z.object({ connection: z.literal('disconnected'), status: z.null() }).strict(),
]);

export const DevAcceptanceCapturePipelineStatusSchema = z
  .object({
    captureId: IdSchema,
    ocrStatus: z.enum(['not_requested', 'queued', 'running', 'succeeded', 'failed', 'blocked']),
    embeddingStatus: z.enum(['not_requested', 'pending', 'indexed', 'failed']).nullable(),
    indexStatus: z.enum(['not_indexed', 'pending', 'indexed', 'failed', 'stale']).nullable(),
  })
  .strict();

export type DevAcceptanceCaptureState = z.infer<typeof DevAcceptanceCaptureStateSchema>;
export type DevAcceptanceCapturePauseReason = z.infer<typeof DevAcceptanceCapturePauseReasonSchema>;
export type DevAcceptanceAdmissionReason = z.infer<typeof DevAcceptanceAdmissionReasonSchema>;
export type DevAcceptanceSafeErrorCode = z.infer<typeof DevAcceptanceSafeErrorCodeSchema>;
export type DevAcceptanceSyncGate = z.infer<typeof DevAcceptanceSyncGateSchema>;
export type DevAcceptanceLocalStage = z.infer<typeof DevAcceptanceLocalStageSchema>;
export type DevAcceptanceDesktopStatus = z.infer<typeof DevAcceptanceDesktopStatusSchema>;
export type DevAcceptanceDesktopStatusResponse = z.infer<
  typeof DevAcceptanceDesktopStatusResponseSchema
>;
export type DevAcceptanceCapturePipelineStatus = z.infer<
  typeof DevAcceptanceCapturePipelineStatusSchema
>;
