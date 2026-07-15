import { describe, expect, it } from 'bun:test';
import { CapabilitiesResponseSchema } from '../index.js';

const now = '2026-07-05T00:00:00.000Z';
const workspaceId = '22222222-2222-4222-8222-222222222222';

describe('capabilities contracts', () => {
  it('parses capabilities with cloud sync disabled explicitly', () => {
    const parsed = CapabilitiesResponseSchema.parse({
      workspaceId,
      features: {
        auth: { enabled: true },
        invite: { enabled: true },
        manualSubscription: { enabled: true },
        providerSettings: { enabled: true },
        captureIngestion: { enabled: true },
        temporaryOcr: { enabled: true },
        textSearch: { enabled: true },
        embeddingSearch: { enabled: false, reason: 'provider_not_configured' },
        hybridSearch: { enabled: false, reason: 'hybrid_search_not_enabled' },
        cloudSync: { enabled: false, reason: 'cloud_sync_not_enabled' },
      },
      limits: { ocrJobsPerMonth: 100 },
      usage: { ocrJobsThisMonth: 0 },
      providers: [
        {
          service: 'ocr',
          enabled: true,
          provider: 'openai-compatible',
          model: 'vision-default',
          hasSecret: true,
        },
        {
          service: 'embedding',
          enabled: false,
          hasSecret: false,
          reason: 'provider_not_configured',
        },
      ],
      server: {
        contractVersion: 'v1',
        minimumSidecarContractVersion: 'v1',
        supportedPlatforms: ['macos'],
      },
      generatedAt: now,
    });

    expect(parsed.features.cloudSync.enabled).toBe(false);
    expect(parsed.features.cloudSync.reason).toBe('cloud_sync_not_enabled');
  });
});
