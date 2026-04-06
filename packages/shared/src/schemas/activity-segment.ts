import { z } from "zod/v4";

export const sceneTypeSchema = z.enum([
  "coding",
  "chatting",
  "browsing",
  "designing",
  "meeting",
  "reading",
  "writing",
  "terminal",
  "other",
]);

export type SceneType = z.infer<typeof sceneTypeSchema>;

export const activitySegmentSchema = z.object({
  id: z.string(),
  app_name: z.string(),
  bundle_id: z.string(),
  display_ids: z.array(z.number().int()),
  session_start: z.coerce.date(),
  session_end: z.coerce.date(),
  duration_seconds: z.number().int(),
  activity: z.string(),
  scene_type: sceneTypeSchema,
  summary: z.string(),
  visual_elements: z.array(z.string()),
  key_entities: z.array(z.unknown()),
  activity_tokenized: z.string().nullable().optional(),
  summary_tokenized: z.string().nullable().optional(),
  screenshot_ids: z.array(z.string()),
  frame_count: z.number().int(),
  selected_frame_count: z.number().int(),
  embedding: z.array(z.number()).nullable().optional(),
  embedding_model: z.string(),
  schema_version: z.number().int(),
  timezone: z.string(),
  local_date: z.string(),
  llm_model: z.string(),
  llm_tokens_in: z.number().int(),
  llm_tokens_out: z.number().int(),
  processed_at: z.coerce.date(),
});

export type ActivitySegment = z.infer<typeof activitySegmentSchema>;

export const activitySegmentCreateSchema = z.object({
  app_name: z.string(),
  bundle_id: z.string(),
  display_ids: z.array(z.number().int()),
  session_start: z.coerce.date(),
  session_end: z.coerce.date(),
  duration_seconds: z.number().int(),
  activity: z.string(),
  scene_type: sceneTypeSchema,
  summary: z.string(),
  visual_elements: z.array(z.string()),
  key_entities: z.array(z.unknown()),
  activity_tokenized: z.string().nullable().optional(),
  summary_tokenized: z.string().nullable().optional(),
  screenshot_ids: z.array(z.string()),
  frame_count: z.number().int(),
  selected_frame_count: z.number().int(),
  timezone: z.string(),
  local_date: z.string(),
  llm_model: z.string(),
  llm_tokens_in: z.number().int(),
  llm_tokens_out: z.number().int(),
});

export type ActivitySegmentCreate = z.infer<typeof activitySegmentCreateSchema>;
