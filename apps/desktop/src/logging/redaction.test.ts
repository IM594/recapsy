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

  it('redacts authorization headers, inline secrets, paths, URL queries, and sensitive content text', () => {
    const redacted = redactLogPayload({
      authorization: 'Bearer auth-token-value',
      errorMessage:
        'Bearer auth-token-value sk-provider-secret /Users/alice/Pictures/capture.png file:///Users/alice/capture.png https://api.example.test/v1/ocr?image=secret OCR raw text provider response body',
      nested: {
        messageSafe:
          'Provider said sk-provider-secret while reading /private/tmp/capture.png and OCR raw text',
        providerResponseBody: 'provider body with image bytes and OCR raw text',
      },
    });
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('auth-token-value');
    expect(serialized).not.toContain('sk-provider-secret');
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('/private/tmp');
    expect(serialized).not.toContain('file:///Users');
    expect(serialized).not.toContain('image=secret');
    expect(serialized).not.toContain('OCR raw text');
    expect(serialized).not.toContain('provider response body');
    expect(serialized).not.toContain('image bytes');
    expect(redacted).toMatchObject({
      authorization: '[redacted:secret]',
      nested: {
        providerResponseBody: '[redacted:content]',
      },
    });
  });
});
