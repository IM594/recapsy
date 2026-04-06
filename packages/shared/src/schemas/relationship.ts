import { z } from "zod/v4";

export const relationTypeSchema = z.enum([
  "co_appeared",
  "mentioned",
  "used_with",
  "belongs_to",
  "derived_from",
]);

export type RelationType = z.infer<typeof relationTypeSchema>;

export const relationshipSchema = z.object({
  id: z.string(),
  in: z.string(),
  out: z.string(),
  relation_type: relationTypeSchema,
  weight: z.number(),
  first_seen: z.coerce.date(),
  last_seen: z.coerce.date(),
  count: z.number().int(),
  created_at: z.coerce.date(),
});

export type Relationship = z.infer<typeof relationshipSchema>;

export const appearedInSchema = z.object({
  id: z.string(),
  in: z.string(),
  out: z.string(),
  timestamp: z.coerce.date(),
  confidence: z.number(),
  context: z.string().nullable().optional(),
  created_at: z.coerce.date(),
});

export type AppearedIn = z.infer<typeof appearedInSchema>;

export const appearedInSegmentSchema = z.object({
  id: z.string(),
  in: z.string(),
  out: z.string(),
  source: z.string(),
  confidence: z.number(),
  created_at: z.coerce.date(),
});

export type AppearedInSegment = z.infer<typeof appearedInSegmentSchema>;
