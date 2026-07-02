import { z } from 'zod';

/** Timeline event types written to `timeline_events` (Phase 1). */
export const TimelineEventTypeSchema = z.enum(['app_focus', 'context_focus', 'dedup', 'blocked']);

export type TimelineEventType = z.infer<typeof TimelineEventTypeSchema>;

/** `payload.reason` for `type=blocked` (O13=A: all four report with appName). */
export const BlockedReasonSchema = z.enum([
  'app_blacklist',
  'incognito',
  'secure_input',
  'user_paused',
]);

export type BlockedReason = z.infer<typeof BlockedReasonSchema>;

/** `type=app_focus` payload — foreground app changed. */
export const AppFocusPayloadSchema = z.object({
  appName: z.string().min(1),
  bundleId: z.string().min(1).optional(),
});

export type AppFocusPayload = z.infer<typeof AppFocusPayloadSchema>;

/** `type=context_focus` payload — context changed within the same app. */
export const ContextFocusPayloadSchema = z.object({
  appName: z.string().min(1),
  windowTitle: z.string().min(1),
  url: z.string().url().optional(),
  contextFingerprint: z.string().min(1).optional(),
});

export type ContextFocusPayload = z.infer<typeof ContextFocusPayloadSchema>;

/** `type=dedup` payload — allowed capture, visual similarity within W20 threshold. */
export const DedupPayloadSchema = z.object({
  reason: z.literal('dedup'),
  imageHash: z.string().min(1),
  hamming: z.number().int().nonnegative(),
  threshold: z.number().int().positive(),
  skippedUpload: z.boolean().optional(),
});

export type DedupPayload = z.infer<typeof DedupPayloadSchema>;

/** `type=blocked` payload — privacy gate; must not carry image data (O13=A). */
export const BlockedPayloadSchema = z
  .object({
    reason: BlockedReasonSchema,
    /** Required per O13=A: all blocked reasons report with appName. */
    appName: z.string().min(1),
    visualState: z.literal('unknown').optional(),
  })
  .strict()
  .refine((payload) => !('imageHash' in payload), {
    message: 'blocked payload must not include imageHash',
  });

export type BlockedPayload = z.infer<typeof BlockedPayloadSchema>;

const timelineEventEnvelopeBaseSchema = z.object({
  clientEventId: z.string().min(1),
  capturedAt: z.string().datetime(),
  /**
   * Monotonic within a single client process; restarts from 0 on process restart.
   * Ordering: `capturedAt` primary, `sequence` secondary tiebreaker (R8③).
   */
  sequence: z.number().int().nonnegative(),
  appName: z.string().min(1),
  windowTitle: z.string().nullable().optional(),
});

/** Unified timeline event envelope for light-weight client uploads. */
export const TimelineEventEnvelopeSchema = z.discriminatedUnion('type', [
  timelineEventEnvelopeBaseSchema.extend({
    type: z.literal('app_focus'),
    payload: AppFocusPayloadSchema,
  }),
  timelineEventEnvelopeBaseSchema.extend({
    type: z.literal('context_focus'),
    payload: ContextFocusPayloadSchema,
  }),
  timelineEventEnvelopeBaseSchema.extend({
    type: z.literal('dedup'),
    payload: DedupPayloadSchema,
  }),
  timelineEventEnvelopeBaseSchema.extend({
    type: z.literal('blocked'),
    payload: BlockedPayloadSchema,
  }),
]);

export type TimelineEventEnvelope = z.infer<typeof TimelineEventEnvelopeSchema>;

/** Batch upload request for `POST /v1/ingest/events` (1–50 events per batch). */
export const TimelineEventsBatchRequestSchema = z.object({
  events: z.array(TimelineEventEnvelopeSchema).min(1).max(50),
});

export type TimelineEventsBatchRequest = z.infer<typeof TimelineEventsBatchRequestSchema>;

export const TimelineEventIngestResultStatusSchema = z.enum(['accepted', 'duplicate', 'rejected']);

export type TimelineEventIngestResultStatus = z.infer<typeof TimelineEventIngestResultStatusSchema>;

/** Per-event result in a batch upload response. */
export const TimelineEventIngestResultSchema = z.object({
  clientEventId: z.string().min(1),
  status: TimelineEventIngestResultStatusSchema,
  id: z.string().uuid().optional(),
  error: z.string().optional(),
});

export type TimelineEventIngestResult = z.infer<typeof TimelineEventIngestResultSchema>;

/** Batch upload response with one result per submitted event. */
export const TimelineEventsBatchResponseSchema = z.object({
  results: z.array(TimelineEventIngestResultSchema),
});

export type TimelineEventsBatchResponse = z.infer<typeof TimelineEventsBatchResponseSchema>;
