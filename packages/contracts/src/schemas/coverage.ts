import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema, PageInfoSchema } from './common.js';

// Capture coverage spine.
//
// Every capture tick produces exactly one of two facts: a frame was written
// (see `capture.result` / CaptureSchema), or no frame was written and there is
// a reason. Coverage states are those reasons. They are recorded as run-length
// segments (a contiguous run of ticks in the same state) rather than one row
// per tick, so a static hour costs one growing segment instead of ~1200 rows.
//
// `gap` / `not_running` are deliberately NOT states here: the absence of any
// fact for a tick, combined with device liveness, lets the read model infer a
// capture gap. Recording a gap as a coverage state would fabricate a fact the
// device never observed.
export const CaptureCoverageStateSchema = z.enum([
  'static', // screen unchanged vs the previous accepted frame; read model holds the prior frame
  'blank', // blank frame
  'low_information', // low-information frame
  'no_window', // no capturable foreground window
  'privacy_withheld', // capture withheld by privacy/policy decision
  'secure_field', // a secure input field was present
  'private_context', // a private context was present
  'paused', // capture paused by the app (user, backpressure, permission, or policy)
]);

// The device's own view of whether capture is alive and what it is currently
// doing. Distinct from coverage: liveness answers "is the engine running?",
// coverage answers "the engine ran but produced no frame — why?".
export const DeviceCaptureDesiredStateSchema = z.enum(['running', 'paused', 'stopped']);

// A closed run of same-state ticks. `startedAt`/`endedAt` are client wall-clock
// facts (same source as capture `observedAt`); `intervalMs` records the tick
// cadence in force for the run so the read model can rebuild the tick grid even
// if the cadence changes between runs.
export const CaptureCoverageSegmentSchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    userId: IdSchema.nullable().optional(),
    deviceId: z.string().min(1).max(256),
    coverageState: CaptureCoverageStateSchema,
    startedAt: IsoDateTimeSchema,
    endedAt: IsoDateTimeSchema,
    tickCount: z.number().int().positive(),
    intervalMs: z.number().int().positive(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

// One closed segment as submitted by the device. The device is authoritative
// for the open (still-growing) segment and only syncs segments once closed.
export const CaptureCoverageSegmentInputSchema = z
  .object({
    deviceId: z.string().min(1).max(256),
    coverageState: CaptureCoverageStateSchema,
    startedAt: IsoDateTimeSchema,
    endedAt: IsoDateTimeSchema,
    tickCount: z.number().int().positive(),
    intervalMs: z.number().int().positive(),
  })
  .strict();

export const CaptureCoverageBatchCreateRequestSchema = z
  .object({
    workspaceId: IdSchema,
    segments: z.array(CaptureCoverageSegmentInputSchema).min(1).max(500),
  })
  .strict();

export const CaptureCoverageBatchCreateResponseSchema = z
  .object({
    segments: z.array(CaptureCoverageSegmentSchema),
  })
  .strict();

// Per-device liveness, upserted (one row per device). `openCoverageState` lets
// monitors and the read model see the tail state of the current still-open
// segment without waiting for it to close.
export const DeviceCaptureLivenessSchema = z
  .object({
    workspaceId: IdSchema,
    deviceId: z.string().min(1).max(256),
    lastAliveAt: IsoDateTimeSchema,
    desiredState: DeviceCaptureDesiredStateSchema,
    openCoverageState: CaptureCoverageStateSchema.nullable().optional(),
    openCoverageStartedAt: IsoDateTimeSchema.nullable().optional(),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const DeviceCaptureLivenessUpsertRequestSchema = z
  .object({
    workspaceId: IdSchema,
    deviceId: z.string().min(1).max(256),
    lastAliveAt: IsoDateTimeSchema,
    desiredState: DeviceCaptureDesiredStateSchema,
    openCoverageState: CaptureCoverageStateSchema.nullable().optional(),
    openCoverageStartedAt: IsoDateTimeSchema.nullable().optional(),
  })
  .strict();

export const DeviceCaptureLivenessResponseSchema = z
  .object({
    liveness: DeviceCaptureLivenessSchema,
  })
  .strict();

// Filmstrip read model — a reconstructed, replay-oriented view over the
// coverage spine. Nothing here is stored: the read model rebuilds the expected
// tick grid over a time range at a caller-chosen cadence and classifies each
// slot from recorded facts (accepted frames + coverage segments + device
// liveness). `hold` means replay holds the last accepted frame (screen was
// static); `idle` carries a non-static coverage reason; `gap` means the fact
// stream is missing where it should not be, split into `frame_drop` (engine
// alive, an isolated lost tick) and `downtime` (engine stale while meant to be
// running — a silent capture stop that must stay visible, never hidden).
export const FilmstripTickDispositionSchema = z.enum([
  'accepted',
  'hold',
  'idle',
  'gap',
  'anomaly',
]);

export const FilmstripGapKindSchema = z.enum(['frame_drop', 'downtime']);

export const FilmstripTickSchema = z
  .object({
    at: IsoDateTimeSchema,
    disposition: FilmstripTickDispositionSchema,
    captureId: IdSchema.optional(),
    heldFromCaptureId: IdSchema.optional(),
    reason: CaptureCoverageStateSchema.optional(),
    gapKind: FilmstripGapKindSchema.optional(),
  })
  .strict();

export const FilmstripQuerySchema = z
  .object({
    workspaceId: IdSchema,
    deviceId: z.string().min(1).max(256),
    from: IsoDateTimeSchema,
    to: IsoDateTimeSchema,
    // The tick cadence the caller wants the grid reconstructed at. Not a stored
    // fact: filmstrip resolution is a read-time choice.
    intervalMs: z.number().int().min(200).max(600_000),
    limit: z.number().int().positive().max(5_000).default(500),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export const FilmstripResponseSchema = z
  .object({
    workspaceId: IdSchema,
    deviceId: z.string().min(1).max(256),
    ticks: z.array(FilmstripTickSchema),
    pageInfo: PageInfoSchema,
    generatedAt: IsoDateTimeSchema,
  })
  .strict();

export type CaptureCoverageState = z.infer<typeof CaptureCoverageStateSchema>;
export type DeviceCaptureDesiredState = z.infer<typeof DeviceCaptureDesiredStateSchema>;
export type CaptureCoverageSegment = z.infer<typeof CaptureCoverageSegmentSchema>;
export type CaptureCoverageSegmentInput = z.infer<typeof CaptureCoverageSegmentInputSchema>;
export type CaptureCoverageBatchCreateRequest = z.infer<
  typeof CaptureCoverageBatchCreateRequestSchema
>;
export type CaptureCoverageBatchCreateResponse = z.infer<
  typeof CaptureCoverageBatchCreateResponseSchema
>;
export type DeviceCaptureLiveness = z.infer<typeof DeviceCaptureLivenessSchema>;
export type DeviceCaptureLivenessUpsertRequest = z.infer<
  typeof DeviceCaptureLivenessUpsertRequestSchema
>;
export type DeviceCaptureLivenessResponse = z.infer<typeof DeviceCaptureLivenessResponseSchema>;
export type FilmstripTickDisposition = z.infer<typeof FilmstripTickDispositionSchema>;
export type FilmstripGapKind = z.infer<typeof FilmstripGapKindSchema>;
export type FilmstripTick = z.infer<typeof FilmstripTickSchema>;
export type FilmstripQuery = z.infer<typeof FilmstripQuerySchema>;
export type FilmstripResponse = z.infer<typeof FilmstripResponseSchema>;
