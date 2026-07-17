import { describe, expect, it } from 'bun:test';
import { HELPER_PROTOCOL_VERSION } from '../types';
import { validateHelperToMainEnvelope, validateMainToHelperEnvelope } from '../validation';

const sentAt = '2026-07-15T00:00:00.000Z';

describe('helper protocol direction validation', () => {
  it('accepts every Helper-to-Main message only in the Helper-to-Main direction', () => {
    for (const envelope of helperToMainEnvelopes()) {
      expect(validateHelperToMainEnvelope(envelope).ok).toBe(true);
      expect(validateMainToHelperEnvelope(envelope)).toMatchObject({
        error: { code: 'schema_mismatch' },
        ok: false,
      });
    }
  });

  it('accepts every Main-to-Helper message only in the Main-to-Helper direction', () => {
    for (const envelope of mainToHelperEnvelopes()) {
      expect(validateMainToHelperEnvelope(envelope).ok).toBe(true);
      expect(validateHelperToMainEnvelope(envelope)).toMatchObject({
        error: { code: 'schema_mismatch' },
        ok: false,
      });
    }
  });

  it('does not echo payloads, local paths, or secrets when direction validation fails', () => {
    const result = validateHelperToMainEnvelope({
      ...baseEnvelope('capture.start'),
      correlationId: '/Users/alice/private.txt',
      messageId: 'provider-secret-token',
      payload: { reason: 'runtime_started', secret: 'sk-1234567890abcdef' },
    });

    expect(result).toEqual({
      error: {
        code: 'schema_mismatch',
        message: 'Helper envelope type is not valid for this protocol direction.',
        messageType: 'capture.start',
      },
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain('/Users/alice');
    expect(JSON.stringify(result)).not.toContain('provider-secret-token');
    expect(JSON.stringify(result)).not.toContain('sk-');
  });

  it('fails closed for capture context strings containing paths, file URLs, or secrets', () => {
    const unsafeContextVariants = [
      { window: { title: '/Users/alice/Documents/private.txt' } },
      { document: { name: 'file://Users/alice/Documents/private.txt' } },
      { website: { host: 'example.com', origin: 'https://example.com/path?token=secret' } },
      { window: { title: 'OpenAI key sk-1234567890abcdef1234567890abcdef' } },
      { axText: 'private selected text' },
    ];

    for (const contextVariant of unsafeContextVariants) {
      const payload = captureResultPayload();
      const result = validateHelperToMainEnvelope({
        ...baseEnvelope('capture.result'),
        payload: {
          ...payload,
          context: { ...payload.context, ...contextVariant },
        },
      });

      expect(result).toMatchObject({ error: { code: 'schema_mismatch' }, ok: false });
      expect(JSON.stringify(result)).not.toContain('/Users/alice');
      expect(JSON.stringify(result)).not.toContain('file://');
      expect(JSON.stringify(result)).not.toContain('token=secret');
      expect(JSON.stringify(result)).not.toContain('sk-');
      expect(JSON.stringify(result)).not.toContain('private selected text');
    }
  });

  it('accepts safe capture context basenames, window titles, and website origins', () => {
    const payload = captureResultPayload();
    const result = validateHelperToMainEnvelope({
      ...baseEnvelope('capture.result'),
      payload: {
        ...payload,
        context: {
          ...payload.context,
          document: { name: 'notes.md' },
          website: { host: 'example.com', origin: 'https://example.com' },
          window: { title: 'Quarterly Planning' },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it('distinguishes unknown message types from known types in the wrong direction', () => {
    expect(
      validateHelperToMainEnvelope({ ...baseEnvelope('capture.raw_debug'), payload: {} }),
    ).toMatchObject({ error: { code: 'unknown_message_type' }, ok: false });
    expect(
      validateHelperToMainEnvelope({
        ...baseEnvelope('capture.ack'),
        payload: { captureId: 'cap_1' },
      }),
    ).toMatchObject({ error: { code: 'schema_mismatch' }, ok: false });
  });
});

function helperToMainEnvelopes(): unknown[] {
  return [
    envelope('helper.hello', {
      capabilities: { capture: true, mock: true, permissions: true },
      helperVersion: 'helper/1.0.0',
      pid: 42,
    }),
    envelope('helper.status', { status: 'ready' }),
    envelope('permission.status', {
      accessibility: 'granted',
      observedAt: sentAt,
      screenCapture: 'granted',
    }),
    envelope('capture.result', captureResultPayload()),
    envelope('capture.skipped', { captureId: 'cap_1', observedAt: sentAt, reason: 'paused' }),
    envelope('capture.error', { captureId: 'cap_1', code: 'capture_failed', message: 'Failed.' }),
    envelope('helper.heartbeat', { sequence: 1, status: 'ready' }),
    envelope('helper.exiting', { code: 0, reason: 'shutdown_requested' }),
  ];
}

function mainToHelperEnvelopes(): unknown[] {
  return [
    envelope('helper.configure', { captureIntervalMs: 1000, policyVersion: 'policy-v1' }),
    envelope('permission.refresh', {}),
    envelope('capture.start', { reason: 'runtime_started' }),
    envelope('capture.pause', { reason: 'user_paused' }),
    envelope('capture.resume', { reason: 'user_resumed' }),
    envelope('capture.flush', { reason: 'manual' }),
    envelope('capture.ack', { captureId: 'cap_1' }),
    envelope('capture.nack', {
      captureId: 'cap_1',
      code: 'storage_unavailable',
      message: 'Capture could not be queued locally.',
    }),
    envelope('helper.shutdown', { reason: 'quit' }),
  ];
}

function envelope(type: string, payload: unknown): unknown {
  return { ...baseEnvelope(type), payload };
}

function baseEnvelope(type: string) {
  return {
    correlationId: null,
    messageId: `msg_${type}`,
    protocolVersion: HELPER_PROTOCOL_VERSION,
    sentAt,
    type,
  };
}

function captureResultPayload() {
  return {
    assets: [
      {
        hash: 'sha256:asset',
        mimeType: 'image/png',
        ref: 'opaque:asset:cap_1',
        role: 'screenshot',
        sizeBytes: 1,
      },
    ],
    captureId: 'cap_1',
    context: {
      observedAt: sentAt,
      policy: { decision: 'allow', version: 'policy-v1' },
    },
    manifest: {
      hash: 'sha256:manifest',
      mimeType: 'application/json',
      ref: 'opaque:manifest:cap_1',
      role: 'manifest',
      sizeBytes: 0,
    },
    observedAt: sentAt,
  };
}
