import { describe, expect, it } from 'bun:test';
import {
  AxAllowlistResponseSchema,
  CapturePolicyRuleSchema,
  LocalCapturePolicyRuleKindSchema,
} from '../../index.js';

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

describe('capture policy text', () => {
  it('rejects NUL characters used to construct ambiguous canonical sort keys', () => {
    const rule = {
      action: 'block_capture' as const,
      enabled: true,
      id: 'rule\u0000one',
      kind: 'bundle_id' as const,
      pattern: 'com.example.safe',
      scope: 'workspace_default' as const,
    };
    const patternRule = { ...rule, id: 'rule-one', pattern: 'com.example\u0000safe' };

    expect(CapturePolicyRuleSchema.safeParse(rule).success).toBe(false);
    expect(CapturePolicyRuleSchema.safeParse(patternRule).success).toBe(false);
  });
});

describe('local capture policy rule kinds', () => {
  it('accepts only whole-app and whole-domain local rules', () => {
    expect(LocalCapturePolicyRuleKindSchema.safeParse('bundle_id').success).toBe(true);
    expect(LocalCapturePolicyRuleKindSchema.safeParse('domain').success).toBe(true);
    expect(LocalCapturePolicyRuleKindSchema.safeParse('domain_family').success).toBe(true);
    expect(LocalCapturePolicyRuleKindSchema.safeParse('url_path_prefix').success).toBe(false);
  });
});
