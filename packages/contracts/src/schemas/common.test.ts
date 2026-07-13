import { expect, test } from 'bun:test';
import { ApiErrorCodeSchema } from './common.js';

test('API error contracts reject retired temporary-upload errors', () => {
  const retiredCode = ['storage', 'temporary_upload_expired'].join('.');

  expect(ApiErrorCodeSchema.safeParse(retiredCode).success).toBe(false);
});
