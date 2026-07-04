import { z } from 'zod';

export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const IdSchema = z.string().uuid();

export const MetadataSchema = z.record(z.string(), z.unknown());

export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  statusCode: z.number().int(),
  requestId: z.string().optional(),
});

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
  line: z.literal('next'),
  version: z.string().optional(),
  uptimeSeconds: z.number().nonnegative().optional(),
});

export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
export type Pagination = z.infer<typeof PaginationSchema>;
export type PageInfo = z.infer<typeof PageInfoSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
