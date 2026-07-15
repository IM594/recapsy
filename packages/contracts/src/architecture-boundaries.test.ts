import { describe, expect, test } from 'bun:test';

describe('contracts naming boundaries', () => {
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
