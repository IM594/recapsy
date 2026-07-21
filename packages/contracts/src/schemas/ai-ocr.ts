import { z } from 'zod';

// Contracts for the authenticated OCR pass-through proxy (`POST /v1/ai/ocr`).
// The request carries raw image bytes with a `Content-Type` header and a
// `workspaceId` query parameter; there is no JSON request body, so only the
// normalized response is described here. The provider endpoint, model, prompt
// and API key are bound to server-side provider settings and are never
// accepted from the client.

export const AiOcrBoundingBoxSchema = z
  .object({
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
  })
  .strict();

export const AiOcrTextBlockSchema = z
  .object({
    text: z.string(),
    order: z.number().int().nonnegative().optional(),
    kind: z.string().min(1).max(64).optional(),
    bbox: AiOcrBoundingBoxSchema.optional(),
  })
  .strict();

export const AiOcrUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
  })
  .strict();

// How the provider call finished. `output_truncated` means the model hit its
// output-token ceiling: the transcribed text so far is still real (kept, not
// discarded) but incomplete, which the desktop turns into a `truncated` quality
// flag. Optional so callers that don't observe completion default to complete.
export const AiOcrCompletionSchema = z
  .object({
    stopReason: z.enum(['complete', 'output_truncated']),
    outputTokensCapped: z.boolean(),
  })
  .strict();

export const AiOcrResponseSchema = z
  .object({
    text: z.string(),
    blocks: z.array(AiOcrTextBlockSchema),
    model: z.string().min(1),
    providerName: z.string().min(1),
    usage: AiOcrUsageSchema.optional(),
    completion: AiOcrCompletionSchema.optional(),
    durationMs: z.number().int().nonnegative(),
    providerRequestId: z.string().min(1).max(128).optional(),
  })
  .strict();

export type AiOcrBoundingBox = z.infer<typeof AiOcrBoundingBoxSchema>;
export type AiOcrTextBlock = z.infer<typeof AiOcrTextBlockSchema>;
export type AiOcrUsage = z.infer<typeof AiOcrUsageSchema>;
export type AiOcrCompletion = z.infer<typeof AiOcrCompletionSchema>;
export type AiOcrResponse = z.infer<typeof AiOcrResponseSchema>;
