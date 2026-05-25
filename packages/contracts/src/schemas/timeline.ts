import { z } from 'zod';

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

/** A single timeline capture */
export const TimelineCaptureSchema = z.object({
  id: z.string().uuid(),
  capturedAt: z.string().datetime(),
  appName: z.string().nullable(),
  windowTitle: z.string().nullable(),
  searchText: z.string().nullable(),
});

export type TimelineCapture = z.infer<typeof TimelineCaptureSchema>;

/** Timeline response */
export const TimelineResponseSchema = z.object({
  captures: z.array(TimelineCaptureSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(100),
  offset: z.number().int().nonnegative(),
});

export type TimelineResponse = z.infer<typeof TimelineResponseSchema>;
