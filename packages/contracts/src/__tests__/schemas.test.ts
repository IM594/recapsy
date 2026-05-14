import { describe, expect, test } from 'bun:test';
import { CaptureSchema, IngestRequestSchema } from '../schemas/capture.js';
import { SearchQuerySchema } from '../schemas/search.js';

describe('IngestRequestSchema', () => {
  test('parses valid input', () => {
    const result = IngestRequestSchema.safeParse({
      capturedAt: '2024-01-01T00:00:00Z',
      appName: 'Chrome',
      windowTitle: 'GitHub',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capturedAt).toBe('2024-01-01T00:00:00Z');
      expect(result.data.appName).toBe('Chrome');
    }
  });

  test('rejects invalid capturedAt', () => {
    const result = IngestRequestSchema.safeParse({
      capturedAt: 'not-a-date',
    });

    expect(result.success).toBe(false);
  });
});

describe('SearchQuerySchema', () => {
  test('parses with defaults for limit and offset', () => {
    const result = SearchQuerySchema.safeParse({
      query: 'hello world',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
      expect(result.data.offset).toBe(0);
    }
  });
});

describe('CaptureSchema', () => {
  test('parses valid capture', () => {
    const result = CaptureSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      capturedAt: '2024-01-01T00:00:00Z',
      appName: 'Chrome',
      windowTitle: 'GitHub',
      ocrText: 'Some text',
      storagePath: 'screenshots/test.png',
      status: 'completed',
      metadata: null,
      createdAt: '2024-01-01T00:00:00Z',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('completed');
    }
  });
});
