import { describe, expect, it } from 'bun:test';
import {
  AdminProviderModelsResponseSchema,
  AdminProviderSettingCreateRequestSchema,
  AdminProviderSettingResponseSchema,
  ProviderSettingMaskSchema,
  ResolvedProviderSettingsSchema,
} from '../../index.js';

const now = '2026-07-05T00:00:00.000Z';
const ids = {
  user: '11111111-1111-4111-8111-111111111111',
  workspace: '22222222-2222-4222-8222-222222222222',
  providerSetting: '66666666-6666-4666-8666-666666666666',
};
const providerSetting = {
  id: ids.providerSetting,
  service: 'ocr',
  scopeType: 'global',
  provider: 'openai-compatible',
  endpointMask: 'https://api.example.test/v1',
  model: 'vision-default',
  status: 'active',
  priority: 0,
  defaultParams: { detail: 'high' },
  rateLimit: { requestsPerMinute: 60 },
  secretMask: {
    status: 'configured',
    hasSecret: true,
    mask: 'sk-...1234',
    last4: '1234',
    updatedAt: now,
  },
  createdAt: now,
  updatedAt: now,
} as const;

describe('provider settings contracts', () => {
  it('accepts write-only secret input and masks read responses', () => {
    const createRequest = AdminProviderSettingCreateRequestSchema.parse({
      service: 'ocr',
      provider: 'openai-compatible',
      endpoint: 'https://api.example.test/v1',
      model: 'vision-default',
      secret: 'sk-live-write-only',
    });

    expect(createRequest.secret).toBe('sk-live-write-only');
    const parsed = ProviderSettingMaskSchema.parse(providerSetting);
    expect(parsed.secretMask.last4).toBe('1234');
    expect('secret' in parsed).toBe(false);
    expect(
      ProviderSettingMaskSchema.safeParse({
        ...providerSetting,
        secret: 'sk-live-should-never-read',
      }).success,
    ).toBe(false);
    expect(
      ProviderSettingMaskSchema.safeParse({ ...providerSetting, encryptedSecret: 'ciphertext' })
        .success,
    ).toBe(false);
    expect(
      AdminProviderSettingResponseSchema.parse({ setting: providerSetting }).setting.secretMask
        .status,
    ).toBe('configured');
  });

  it('parses resolved provider settings without changing their wire shape', () => {
    const parsed = ResolvedProviderSettingsSchema.parse({
      workspaceId: ids.workspace,
      userId: ids.user,
      resolutionOrder: ['user', 'workspace', 'global'],
      settings: [
        { service: 'ocr', resolvedFrom: 'global', setting: providerSetting },
        { service: 'embedding', resolvedFrom: 'none', setting: null },
      ],
      generatedAt: now,
    });

    expect(parsed.resolutionOrder).toEqual(['user', 'workspace', 'global']);
    expect(parsed.settings[0]?.resolvedFrom).toBe('global');
  });

  it('parses a provider models response and rejects blank model ids', () => {
    const parsed = AdminProviderModelsResponseSchema.parse({
      settingId: ids.providerSetting,
      provider: 'openai-compatible',
      endpointMask: 'https://api.example.test/v1',
      models: ['bge-m3', 'Qwen3.6-35B-A3B'],
      fetchedAt: now,
    });
    expect(parsed.models).toHaveLength(2);
    expect(
      AdminProviderModelsResponseSchema.safeParse({
        settingId: ids.providerSetting,
        provider: 'openai-compatible',
        models: [''],
        fetchedAt: now,
      }).success,
    ).toBe(false);
  });
});
