import { expect, test } from 'bun:test';
import { ApiErrorCodeSchema, ApiErrorSchema, PaginationSchema } from '../common.js';

test('API error contracts accept the safe OCR provider configuration code', () => {
  expect(ApiErrorCodeSchema.parse('ocr.provider_configuration_invalid')).toBe(
    'ocr.provider_configuration_invalid',
  );
  expect(ApiErrorCodeSchema.parse('providerSettings.capability_invalid')).toBe(
    'providerSettings.capability_invalid',
  );
});

test('API error contracts reject retired temporary-upload errors', () => {
  const retiredCode = ['storage', 'temporary_upload_expired'].join('.');

  expect(ApiErrorCodeSchema.safeParse(retiredCode).success).toBe(false);
});

test('API error contracts reject retired OCR execution errors', () => {
  expect(ApiErrorCodeSchema.safeParse('ocr.temporary_location_missing').success).toBe(false);
  expect(ApiErrorCodeSchema.safeParse('ocr.cleanup_failed').success).toBe(false);
});

test('pagination contracts enforce bounded list input', () => {
  expect(PaginationSchema.parse({})).toEqual({ limit: 50 });
  expect(PaginationSchema.parse({ limit: 1, cursor: 'opaque-cursor' })).toEqual({
    limit: 1,
    cursor: 'opaque-cursor',
  });
  for (const limit of [0, -1, 1.5, 101]) {
    expect(PaginationSchema.safeParse({ limit }).success).toBe(false);
  }
});

test('API error contracts parse reusable categorized envelopes', () => {
  const parsed = ApiErrorSchema.parse({
    error: {
      code: 'providerSettings.secret_write_only',
      category: 'providerSettings',
      message: 'Provider secrets are write-only.',
      requestId: 'req_01',
      details: { field: 'secret' },
    },
  });

  expect(parsed.error.category).toBe('providerSettings');
});
