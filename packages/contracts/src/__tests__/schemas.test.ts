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

  test('normalizes blank optional text fields to undefined', () => {
    const result = IngestRequestSchema.safeParse({
      capturedAt: '2024-01-01T00:00:00Z',
      appName: '',
      windowTitle: '   ',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.appName).toBeUndefined();
      expect(result.data.windowTitle).toBeUndefined();
    }
  });

  test('rejects invalid capturedAt', () => {
    const result = IngestRequestSchema.safeParse({
      capturedAt: 'not-a-date',
    });

    expect(result.success).toBe(false);
  });

  test('rejects rawText without rawProvider', () => {
    const result = IngestRequestSchema.safeParse({
      capturedAt: '2024-01-01T00:00:00Z',
      rawText: 'hello world',
    });

    expect(result.success).toBe(false);
  });

  test('rejects rawProvider without rawText', () => {
    const result = IngestRequestSchema.safeParse({
      capturedAt: '2024-01-01T00:00:00Z',
      rawProvider: 'macos-ax',
    });

    expect(result.success).toBe(false);
  });

  test('rejects rawVisibleText without rawText', () => {
    const result = IngestRequestSchema.safeParse({
      capturedAt: '2024-01-01T00:00:00Z',
      rawProvider: 'macos-ax',
      rawVisibleText: 'visible only',
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
      searchText: 'Some text',
      storagePath: 'screenshots/test.png',
      status: 'completed',
      extractions: null,
      enrichment: null,
      type: 'screenshot',
      durationMs: null,
      metadata: null,
      createdAt: '2024-01-01T00:00:00Z',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('completed');
    }
  });

  test('parses degraded capture status', () => {
    const result = CaptureSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      capturedAt: '2024-01-01T00:00:00Z',
      appName: 'Chrome',
      windowTitle: 'GitHub',
      searchText: 'Some text',
      storagePath: 'screenshots/test.png',
      status: 'degraded',
      extractions: null,
      enrichment: null,
      type: 'screenshot',
      durationMs: null,
      metadata: null,
      createdAt: '2024-01-01T00:00:00Z',
    });

    expect(result.success).toBe(true);
  });

  test('parses deleted capture status', () => {
    const result = CaptureSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      capturedAt: '2024-01-01T00:00:00Z',
      appName: 'Chrome',
      windowTitle: 'GitHub',
      searchText: null,
      storagePath: null,
      status: 'deleted',
      extractions: null,
      enrichment: null,
      type: 'screenshot',
      durationMs: null,
      metadata: null,
      createdAt: '2024-01-01T00:00:00Z',
    });

    expect(result.success).toBe(true);
  });
});
