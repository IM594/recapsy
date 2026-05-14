import { z } from 'zod';

/** Search query parameters */
export const SearchQuerySchema = z.object({
  query: z.string().min(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
  /** Filter by app name */
  appName: z.string().optional(),
  /** Filter by time range */
  after: z.string().datetime().optional(),
  before: z.string().datetime().optional(),
});

export type SearchQuery = z.infer<typeof SearchQuerySchema>;

/** A single search result */
export const SearchResultSchema = z.object({
  id: z.string().uuid(),
  capturedAt: z.string().datetime(),
  appName: z.string().nullable(),
  windowTitle: z.string().nullable(),
  /** Relevant text snippet */
  snippet: z.string(),
  /** Relevance score (0-1, higher is better) */
  score: z.number().min(0).max(1),
});

export type SearchResult = z.infer<typeof SearchResultSchema>;

/** Search response */
export const SearchResponseSchema = z.object({
  results: z.array(SearchResultSchema),
  total: z.number().int().nonnegative(),
  query: z.string(),
});

export type SearchResponse = z.infer<typeof SearchResponseSchema>;
