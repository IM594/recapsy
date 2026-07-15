import { describe, expect, test } from 'bun:test';
import path from 'node:path';

describe('contracts naming boundaries', () => {
  test('publishes concise public types and schemas without legacy aliases', async () => {
    const workspaceRoot = path.resolve(import.meta.dir, '../../..');
    const sourceRoots = [
      'packages/contracts/src',
      'apps/server/src',
      'apps/desktop/src',
      'apps/desktop/integration',
    ];
    const sources: string[] = [];
    const glob = new Bun.Glob('**/*.ts');

    for (const sourceRoot of sourceRoots) {
      for await (const relativePath of glob.scan({ cwd: path.join(workspaceRoot, sourceRoot) })) {
        const absolutePath = path.join(workspaceRoot, sourceRoot, relativePath);
        if (absolutePath === import.meta.path) continue;
        sources.push(await Bun.file(absolutePath).text());
      }
    }

    const source = sources.join('\n');
    const retiredSymbols = [
      'EffectiveProviderSettingsResponseSchema',
      'EffectiveProviderSettingsResponse',
      'SubscriptionEntitlementSnapshotSchema',
      'SubscriptionEntitlementSnapshot',
      'SearchQueryRequestSchema',
      'SearchQueryRequest',
      'TimelineQueryRequestSchema',
      'TimelineQueryRequest',
      'AXAllowlistDisabledResponseSchema',
      'AXAllowlistDisabledResponse',
      'AXAllowlistStatusSchema',
      'AXAllowlistStatus',
    ];
    const requiredSymbols = [
      'ResolvedProviderSettingsSchema',
      'ResolvedProviderSettings',
      'EntitlementSnapshotSchema',
      'EntitlementSnapshot',
      'SearchRequestSchema',
      'SearchRequest',
      'TimelineQuerySchema',
      'TimelineQuery',
      'AxAllowlistResponseSchema',
      'AxAllowlistResponse',
      'AxAllowlistStatusSchema',
      'AxAllowlistStatus',
    ];
    const violations = retiredSymbols
      .filter((symbol) => new RegExp(`\\b${symbol}\\b`).test(source))
      .map((symbol) => `retired public contract remains: ${symbol}`);

    for (const symbol of requiredSymbols) {
      if (!new RegExp(`\\b${symbol}\\b`).test(source)) {
        violations.push(`required public contract is missing: ${symbol}`);
      }
    }

    expect(violations).toEqual([]);
  });

  test('capture creation contracts replace retired ingest terminology without aliases', async () => {
    const sources: string[] = [];
    const glob = new Bun.Glob('**/*.ts');
    for await (const relativePath of glob.scan({ cwd: import.meta.dir })) {
      if (relativePath === 'architecture-boundaries.test.ts') continue;
      sources.push(await Bun.file(`${import.meta.dir}/${relativePath}`).text());
    }
    const source = sources.join('\n');
    const retiredSymbols = [
      'CaptureIngestNextActionSchema',
      'CaptureIngestNextAction',
      'CaptureIngestRequestSchema',
      'CaptureIngestRequest',
      'CaptureIngestResponseSchema',
      'CaptureIngestResponse',
      'CaptureSecureOrPrivateHintSchema',
      'CaptureSecureOrPrivateHint',
    ];
    const requiredSymbols = [
      'CaptureNextActionSchema',
      'CaptureNextAction',
      'CaptureCreateRequestSchema',
      'CaptureCreateRequest',
      'CaptureCreateResponseSchema',
      'CaptureCreateResponse',
      'CapturePrivacyHintSchema',
      'CapturePrivacyHint',
    ];
    const violations = retiredSymbols
      .filter((symbol) => new RegExp(`\\b${symbol}\\b`).test(source))
      .map((symbol) => `retired capture contract remains: ${symbol}`);
    if (/\bingest\b/i.test(source)) {
      violations.push('standalone capture ingest terminology remains in contracts or tests');
    }
    for (const symbol of requiredSymbols) {
      if (!new RegExp(`\\b${symbol}\\b`).test(source)) {
        violations.push(`required capture creation contract is missing: ${symbol}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
