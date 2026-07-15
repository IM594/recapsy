import { describe, expect, test } from 'bun:test';
import path from 'node:path';

describe('contracts naming boundaries', () => {
  test('keeps TypeScript tests in approved directories and out of production imports', async () => {
    const packageRoot = path.resolve(import.meta.dir, '..');
    const glob = new Bun.Glob('**/*.ts');
    const violations: string[] = [];

    for (const sourceRoot of ['src', 'tests']) {
      for await (const relativePath of glob.scan({ cwd: path.join(packageRoot, sourceRoot) })) {
        const packageRelativePath = `${sourceRoot}/${relativePath}`;
        const isTestFile = relativePath.endsWith('.test.ts');
        const isSpecFile = relativePath.endsWith('.spec.ts');
        const isApprovedTestLocation =
          /^src\/[^/]+\/tests\/(?:.+\/)?[^/]+\.test\.ts$/.test(packageRelativePath) ||
          /^tests\/(?:.+\/)?[^/]+\.test\.ts$/.test(packageRelativePath);

        if (packageRelativePath.includes('/__tests__/')) {
          violations.push(`uses a forbidden __tests__ directory: ${packageRelativePath}`);
        }
        if (isSpecFile) {
          violations.push(`uses a forbidden .spec.ts test suffix: ${packageRelativePath}`);
        }
        if (isTestFile && !isApprovedTestLocation) {
          violations.push(
            `keeps a TypeScript test outside an approved tests directory: ${packageRelativePath}`,
          );
        }
        if (isTestFile || isSpecFile || sourceRoot !== 'src') continue;

        const source = await Bun.file(path.join(packageRoot, packageRelativePath)).text();
        const importPattern = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
        for (const match of source.matchAll(importPattern)) {
          const specifier = match[1]?.replaceAll('\\', '/');
          if (!specifier) continue;
          if (
            /(^|\/)tests(?:\/|$)/.test(specifier) ||
            /\.(?:test|spec)(?:\.[cm]?[jt]s)?$/.test(specifier)
          ) {
            violations.push(
              `production source imports tests: ${packageRelativePath} -> ${specifier}`,
            );
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test('publishes concise public types and schemas without legacy aliases', async () => {
    const workspaceRoot = path.resolve(import.meta.dir, '../../..');
    const sourceRoots = [
      'packages/contracts/src',
      'apps/server/src',
      'apps/desktop/src',
      'apps/desktop/tests/integration',
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
    const packageRoot = path.resolve(import.meta.dir, '..');
    const sources: string[] = [];
    const glob = new Bun.Glob('**/*.ts');
    for await (const relativePath of glob.scan({ cwd: path.join(packageRoot, 'src') })) {
      sources.push(await Bun.file(path.join(packageRoot, 'src', relativePath)).text());
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
