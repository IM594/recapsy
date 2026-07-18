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
    schemaVersion: z.literal(1),
    runtimeInstanceId: IdSchema,
    workspaceId: IdSchema,
    observedAt: IsoDateTimeSchema,
    acceptedCaptureInputPerMinute: z.number().int().nonnegative(),
    oldestActiveAgeSeconds: z.number().int().nonnegative().nullable(),
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
export type DevAcceptanceDesktopStatus = z.infer<typeof DevAcceptanceDesktopStatusSchema>;
export type DevAcceptanceDesktopStatusResponse = z.infer<
  typeof DevAcceptanceDesktopStatusResponseSchema
>;
