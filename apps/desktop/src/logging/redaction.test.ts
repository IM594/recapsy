import { describe, expect, it } from 'bun:test';
import { redactLogPayload } from './redaction';

describe('log redaction', () => {
  it('redacts token, secret, and path-like fields without mutating safe fields', () => {
    const redacted = redactLogPayload({
      event: 'runtime.start',
      authToken: 'recapsy-token-value',
      providerSecret: 'provider-secret-value',
      assetPath: '/Users/example/Pictures/recapsy/capture.png',
      nested: {
        refresh_token: 'refresh-token-value',
        manifestPath: '/private/tmp/manifest.json',
        status: 'running',
      },
    });

    expect(JSON.stringify(redacted)).not.toContain('recapsy-token-value');
    expect(JSON.stringify(redacted)).not.toContain('provider-secret-value');
    expect(JSON.stringify(redacted)).not.toContain('refresh-token-value');
    expect(JSON.stringify(redacted)).not.toContain('/Users/example');
    expect(JSON.stringify(redacted)).not.toContain('/private/tmp');
    expect(redacted).toMatchObject({
      event: 'runtime.start',
      authToken: '[redacted:secret]',
      providerSecret: '[redacted:secret]',
      assetPath: '[redacted:path]',
      nested: {
        refresh_token: '[redacted:secret]',
        manifestPath: '[redacted:path]',
        status: 'running',
      },
    });
  });
});
