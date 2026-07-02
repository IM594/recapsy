import { z } from 'zod';
import { BlockedReasonSchema } from './timeline-events.js';

/** Timeline query parameters */
export const TimelineQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
  /** Filter by app name */
  appName: z.string().optional(),
  /** Filter by time range */
  after: z.string().datetime().optional(),
  before: z.string().datetime().optional(),
});

export type TimelineQuery = z.infer<typeof TimelineQuerySchema>;

/** A single timeline capture (keyframe) */
export const TimelineCaptureSchema = z.object({
  id: z.string().uuid(),
  capturedAt: z.string().datetime(),
  appName: z.string().nullable(),
  windowTitle: z.string().nullable(),
  searchText: z.string().nullable(),
});

export type TimelineCapture = z.infer<typeof TimelineCaptureSchema>;

export const TimelineCaptureItemSchema = TimelineCaptureSchema.extend({
  kind: z.literal('capture'),
});

export type TimelineCaptureItem = z.infer<typeof TimelineCaptureItemSchema>;

export const TimelineDedupSegmentSchema = z.object({
  kind: z.literal('dedup_segment'),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  appName: z.string(),
  windowTitle: z.string().nullable(),
  imageHash: z.string(),
  count: z.number().int().positive(),
  durationMs: z.number().int().nonnegative(),
});

export type TimelineDedupSegment = z.infer<typeof TimelineDedupSegmentSchema>;

export const TimelineBlockedSegmentSchema = z.object({
  kind: z.literal('blocked_segment'),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  appName: z.string(),
  reason: BlockedReasonSchema.nullable(),
  count: z.number().int().positive(),
  durationMs: z.number().int().nonnegative(),
});

export type TimelineBlockedSegment = z.infer<typeof TimelineBlockedSegmentSchema>;

export const TimelineAppFocusItemSchema = z.object({
  kind: z.literal('app_focus'),
  capturedAt: z.string().datetime(),
  appName: z.string(),
  bundleId: z.string().nullable().optional(),
});

export type TimelineAppFocusItem = z.infer<typeof TimelineAppFocusItemSchema>;

export const TimelineContextFocusItemSchema = z.object({
  kind: z.literal('context_focus'),
  capturedAt: z.string().datetime(),
  appName: z.string(),
  windowTitle: z.string().nullable(),
  contextFingerprint: z.string().nullable().optional(),
});

export type TimelineContextFocusItem = z.infer<typeof TimelineContextFocusItemSchema>;

export const TimelineItemSchema = z.discriminatedUnion('kind', [
  TimelineCaptureItemSchema,
  TimelineDedupSegmentSchema,
  TimelineBlockedSegmentSchema,
  TimelineAppFocusItemSchema,
  TimelineContextFocusItemSchema,
]);

export type TimelineItem = z.infer<typeof TimelineItemSchema>;

export const TimelineResponseModeSchema = z.enum(['events', 'keyframes_only']);

export type TimelineResponseMode = z.infer<typeof TimelineResponseModeSchema>;

/** Timeline response */
export const TimelineResponseSchema = z.object({
  /** Keyframe captures in the query window (backward compat for clients reading captures only) */
  captures: z.array(TimelineCaptureSchema),
  /** Unified timeline items (segments, focus points, keyframes) when events exist */
  items: z.array(TimelineItemSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(100),
  offset: z.number().int().nonnegative(),
  mode: TimelineResponseModeSchema,
});

export type TimelineResponse = z.infer<typeof TimelineResponseSchema>;
