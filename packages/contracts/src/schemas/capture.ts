import { z } from 'zod';

/** Request to ingest a new screen capture */
export const IngestRequestSchema = z.object({
  capturedAt: z.string().datetime(),
  appName: z.string().optional(),
  windowTitle: z.string().optional(),
  /** Base64-encoded screenshot image */
  imageBase64: z.string().optional(),
  /** Pre-extracted raw text (if sensor did local OCR or transcription) */
  rawText: z.string().optional(),
  /** Raw text provider name (if sensor did local OCR or transcription) */
  rawProvider: z.string().optional(),
  /** Pre-extracted visible text only (no structural/AX markers) */
  rawVisibleText: z.string().optional(),
  type: z.enum(['screenshot', 'audio']).default('screenshot').optional(),
  durationMs: z.number().int().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** Perceptual hash from client W20 filter (keyframe uploads). */
  imageHash: z.string().min(1).optional(),
  bundleId: z.string().min(1).optional(),
  contextFingerprint: z.string().min(1).optional(),
  /** Client-generated idempotency key for screenshot uploads. */
  clientEventId: z.string().min(1).optional(),
});

export type IngestRequest = z.infer<typeof IngestRequestSchema>;

/** Response after successful ingestion */
export const IngestResponseSchema = z.object({
  id: z.string().uuid(),
  capturedAt: z.string().datetime(),
  status: z.enum(['queued', 'pending']),
});

export type IngestResponse = z.infer<typeof IngestResponseSchema>;

/** A capture record returned from queries */
export const CaptureSchema = z.object({
  id: z.string().uuid(),
  capturedAt: z.string().datetime(),
  appName: z.string().nullable(),
  windowTitle: z.string().nullable(),
  searchText: z.string().nullable(),
  storagePath: z.string().nullable(),
  status: z.enum(['pending', 'processing', 'completed', 'failed']),
  extractions: z.array(z.unknown()).nullable(),
  enrichment: z.record(z.string(), z.unknown()).nullable(),
  type: z.enum(['screenshot', 'audio', 'blocked']).nullable(),
  durationMs: z.number().int().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string().datetime(),
});

export type Capture = z.infer<typeof CaptureSchema>;
