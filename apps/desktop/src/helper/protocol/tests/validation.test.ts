import { describe, expect, it } from 'bun:test';
import { HELPER_PROTOCOL_VERSION } from '../types';
import {
  isSafeCaptureId,
  validateHelperToMainEnvelope,
  validateMainToHelperEnvelope,
} from '../validation';

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

  it('matches the native helper safe capture id boundary', () => {
    for (const captureId of ['A', 'cap-123_ABC', 'a'.repeat(128)]) {
      expect(isSafeCaptureId(captureId)).toBe(true);
    }

    for (const captureId of [
      '',
      '.',
      '..',
      '../capture',
      'capture/child',
      String.raw`capture\child`,
      '/absolute',
      String.raw`C:\capture`,
      'capture.dot',
      '-capture',
      '_capture',
      'a'.repeat(129),
    ]) {
      expect(isSafeCaptureId(captureId)).toBe(false);
    }
  });

  it('rejects unsafe capture ids in every protocol payload that carries one', () => {
    const unsafeCaptureId = '../outside';
    const resultPayload = captureResultPayload(unsafeCaptureId);
    const helperToMain = [
      envelope('capture.result', resultPayload),
      envelope('capture.coverage', {
        captureId: unsafeCaptureId,
        observedAt: sentAt,
        state: 'paused',
      }),
      envelope('capture.error', {
        captureId: unsafeCaptureId,
        code: 'capture_failed',
        message: 'Failed.',
      }),
    ];
    const mainToHelper = [
      envelope('capture.ack', { captureId: unsafeCaptureId }),
      envelope('capture.nack', {
        captureId: unsafeCaptureId,
        code: 'storage_unavailable',
        message: 'Capture could not be queued locally.',
      }),
    ];

    for (const candidate of helperToMain) {
      expect(validateHelperToMainEnvelope(candidate)).toMatchObject({
        error: { code: 'schema_mismatch' },
        ok: false,
      });
    }
    for (const candidate of mainToHelper) {
      expect(validateMainToHelperEnvelope(candidate)).toMatchObject({
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

  it('accepts a capture result with only the real screenshot asset', () => {
    const payload = captureResultPayload();

    expect(
      validateHelperToMainEnvelope({
        ...baseEnvelope('capture.result'),
        payload,
      }).ok,
    ).toBe(true);
  });

  it('rejects the synthetic manifest field', () => {
    const payload = {
      ...captureResultPayload(),
      manifest: {
        hash: 'sha256:manifest',
        mimeType: 'application/json',
        ref: 'opaque:manifest:cap_1',
        role: 'manifest',
        sizeBytes: 0,
      },
    };
    const result = validateHelperToMainEnvelope({
      ...baseEnvelope('capture.result'),
      payload,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'schema_mismatch' } });
  });

  it('rejects screenshot metadata that diverges from the canonical artifact contract', () => {
    const payload = captureResultPayload();
    const invalidAssets = [
      { ...payload.assets[0], ref: '../outside/screenshot.webp' },
      { ...payload.assets[0], ref: 'another/screenshot.webp' },
      { ...payload.assets[0], hash: 'sha256:asset' },
      { ...payload.assets[0], mimeType: 'image/png' },
      { ...payload.assets[0], sizeBytes: 0 },
    ];

    for (const asset of invalidAssets) {
      expect(
        validateHelperToMainEnvelope({
          ...baseEnvelope('capture.result'),
          payload: { ...payload, assets: [asset] },
        }).ok,
      ).toBe(false);
    }
    expect(
      validateHelperToMainEnvelope({
        ...baseEnvelope('capture.result'),
        payload: {
          ...payload,
          context: { ...payload.context, observedAt: '2026-01-01T00:00:00.000Z' },
        },
      }).ok,
    ).toBe(false);
  });

  it('rejects capture results without a complete final application identity', () => {
    const payload = captureResultPayload();

    for (const app of [
      undefined,
      { name: 'Safari' },
      { bundleId: 'com.apple.Safari' },
      { bundleId: 'com.apple.Safari', name: ' ' },
      { bundleId: 'com/apple/Safari', name: 'Safari' },
    ]) {
      const result = validateHelperToMainEnvelope({
        ...baseEnvelope('capture.result'),
        payload: {
          ...payload,
          context: {
            ...payload.context,
            app,
          },
        },
      });

      expect(result).toMatchObject({ error: { code: 'schema_mismatch' }, ok: false });
    }
  });

  it('accepts low_information as a coverage state and rejects near-miss values', () => {
    expect(
      validateHelperToMainEnvelope(
        envelope('capture.coverage', {
          captureId: 'cap_low_information',
          observedAt: sentAt,
          state: 'low_information',
        }),
      ).ok,
    ).toBe(true);

    expect(
      validateHelperToMainEnvelope(
        envelope('capture.coverage', {
          captureId: 'cap_low_information',
          observedAt: sentAt,
          state: 'low-information',
        }),
      ),
    ).toMatchObject({ error: { code: 'schema_mismatch' }, ok: false });
  });

  it('accepts every capture coverage state and no_window as a first-class reason', () => {
    for (const state of [
      'static',
      'blank',
      'low_information',
      'no_window',
      'privacy_withheld',
      'secure_field',
      'private_context',
      'paused',
    ]) {
      expect(
        validateHelperToMainEnvelope(
          envelope('capture.coverage', { captureId: 'cap_1', observedAt: sentAt, state }),
        ).ok,
      ).toBe(true);
    }
  });

  it('accepts a capture result carrying capturedAt alongside observedAt', () => {
    const payload = { ...captureResultPayload(), capturedAt: sentAt };

    expect(validateHelperToMainEnvelope({ ...baseEnvelope('capture.result'), payload }).ok).toBe(
      true,
    );
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
    envelope('helper.policy_applied', {
      policyHash: `sha256:${'a'.repeat(64)}`,
      policyVersion: 'policy-v1',
    }),
    envelope('permission.status', {
      accessibility: 'granted',
      observedAt: sentAt,
      screenCapture: 'granted',
    }),
    envelope('capture.result', captureResultPayload()),
    envelope('capture.coverage', { captureId: 'cap_1', observedAt: sentAt, state: 'paused' }),
    envelope('capture.error', { captureId: 'cap_1', code: 'capture_failed', message: 'Failed.' }),
    envelope('helper.heartbeat', { sequence: 1, status: 'ready' }),
    envelope('helper.exiting', { code: 0, reason: 'shutdown_requested' }),
  ];
}

function mainToHelperEnvelopes(): unknown[] {
  return [
    envelope('helper.configure', { captureIntervalMs: 1000, policy: capturePolicy() }),
    envelope('permission.refresh', {}),
    envelope('permission.request_screen_capture', {}),
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

function captureResultPayload(captureId = 'cap_1') {
  return {
    assets: [
      {
        hash: `sha256:${'a'.repeat(64)}`,
        mimeType: 'image/webp',
        ref: `${captureId}/screenshot.webp`,
        role: 'screenshot',
        sizeBytes: 1,
      },
    ],
    captureId,
    context: {
      app: { bundleId: 'com.apple.Safari', name: 'Safari' },
      observedAt: sentAt,
      policy: { decision: 'allow', version: 'policy-v1' },
    },
    observedAt: sentAt,
  };
}

function capturePolicy() {
  return {
    defaultAction: 'allow',
    paused: false,
    policyHash: `sha256:${'a'.repeat(64)}`,
    rules: [],
    version: 'policy-v1',
  };
}
