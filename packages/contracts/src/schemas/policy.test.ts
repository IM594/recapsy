import { describe, expect, it } from 'bun:test';
import { AxAllowlistResponseSchema } from '../index.js';

const now = '2026-07-06T00:00:00.000Z';
const workspaceId = '22222222-2222-4222-8222-222222222222';

describe('Ax allowlist contracts', () => {
  it('returns a disabled response with no allowed apps or uploadable fields', () => {
    const parsed = AxAllowlistResponseSchema.parse({
      workspaceId,
      enabled: false,
      axTextUploadEnabled: false,
      status: 'disabled',
      reason: 'ax_text_upload_disabled',
      generatedAt: now,
    });

    expect(parsed.enabled).toBe(false);
    expect('allowedApps' in parsed).toBe(false);
    expect('uploadableFields' in parsed).toBe(false);
    expect(
      AxAllowlistResponseSchema.safeParse({
        workspaceId,
        enabled: false,
        axTextUploadEnabled: false,
        status: 'disabled',
        reason: 'ax_text_upload_disabled',
        generatedAt: now,
        allowedApps: ['com.apple.Safari'],
      }).success,
    ).toBe(false);
  });
});
