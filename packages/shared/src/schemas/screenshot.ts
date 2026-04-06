import { z } from "zod/v4";

export const screenshotStatusSchema = z.enum(["queued", "processing", "done", "dead_letter"]);

export type ScreenshotStatus = z.infer<typeof screenshotStatusSchema>;

// SurrealDB option<T> fields return as absent (undefined) not null,
// so we use .nullable().optional() for fields defined as option<T>
export const screenshotSchema = z.object({
  id: z.string(),
  path: z.string(),
  timestamp: z.coerce.date(),
  app_name: z.string(),
  bundle_id: z.string(),
  window_title: z.string(),
  display_id: z.number().int(),
  ocr_text: z.string().nullable().optional(),
  ocr_text_tokenized: z.string().nullable().optional(),
  is_active: z.boolean(),
  diff_ratio: z.number(),
  resolution: z.string(),
  file_size: z.number().int(),
  status: screenshotStatusSchema,
  retry_count: z.number().int(),
  last_error: z.string().nullable().optional(),
  ocr_truncated: z.boolean(),
  purged: z.boolean(),
  vision_pending: z.boolean(),
  embedding: z.array(z.number()).nullable().optional(),
  embedding_model: z.string(),
  image_embedding: z.array(z.number()).nullable().optional(),
  image_embedding_model: z.string().nullable().optional(),
  timezone: z.string(),
  local_date: z.string(),
  local_hour: z.number().int(),
  capture_id: z.string(),
  created_at: z.coerce.date(),
});

export type Screenshot = z.infer<typeof screenshotSchema>;

export const screenshotCreateSchema = z.object({
  path: z.string(),
  timestamp: z.coerce.date(),
  app_name: z.string(),
  bundle_id: z.string(),
  window_title: z.string(),
  display_id: z.number().int(),
  ocr_text: z.string().nullable().optional(),
  ocr_text_tokenized: z.string().nullable().optional(),
  is_active: z.boolean(),
  diff_ratio: z.number(),
  resolution: z.string(),
  file_size: z.number().int(),
  status: screenshotStatusSchema.optional(),
  capture_id: z.string(),
  timezone: z.string(),
  local_date: z.string(),
  local_hour: z.number().int(),
});

export type ScreenshotCreate = z.infer<typeof screenshotCreateSchema>;
