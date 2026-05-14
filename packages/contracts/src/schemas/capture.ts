import { z } from 'zod';

/** Request to ingest a new screen capture */
export const IngestRequestSchema = z.object({
  capturedAt: z.string().datetime(),
  appName: z.string().optional(),
  windowTitle: z.string().optional(),
  /** Base64-encoded screenshot image */
  imageBase64: z.string().optional(),
  /** Pre-extracted OCR text (if sensor did local OCR) */
  ocrText: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type IngestRequest = z.infer<typeof IngestRequestSchema>;

/** Response after successful ingestion */
export const IngestResponseSchema = z.object({
  id: z.string().uuid(),
  capturedAt: z.string().datetime(),
  status: z.enum(['queued']),
});

export type IngestResponse = z.infer<typeof IngestResponseSchema>;

/** A capture record returned from queries */
export const CaptureSchema = z.object({
  id: z.string().uuid(),
  capturedAt: z.string().datetime(),
  appName: z.string().nullable(),
  windowTitle: z.string().nullable(),
  ocrText: z.string().nullable(),
  storagePath: z.string().nullable(),
  status: z.enum(['pending', 'processing', 'completed', 'failed']),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string().datetime(),
});

export type Capture = z.infer<typeof CaptureSchema>;
