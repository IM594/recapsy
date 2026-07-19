import { describe, expect, it } from 'bun:test';
import { createSafeCaptureResultPayload } from '../capture-result';
import { HELPER_PROTOCOL_VERSION } from '../protocol/types';
import { validateHelperToMainEnvelope } from '../protocol/validation';

const observedAt = '2026-07-19T00:00:00.000Z';

describe('capture result factory', () => {
  it('constructs canonical screenshot metadata accepted by the real protocol validator', () => {
    const payload = createSafeCaptureResultPayload(captureResultInput());

    expect(payload.assets).toEqual([
      {
        hash: `sha256:${'a'.repeat(64)}`,
        mimeType: 'image/webp',
        ref: 'cap_factory/screenshot.webp',
        role: 'screenshot',
        sizeBytes: 1024,
      },
    ]);
    expect(
      validateHelperToMainEnvelope({
        correlationId: null,
        messageId: 'msg_factory',
        payload,
        protocolVersion: HELPER_PROTOCOL_VERSION,
        sentAt: observedAt,
        type: 'capture.result',
      }).ok,
    ).toBe(true);
  });

  it('refuses to construct capture results with unsafe ids or non-positive byte sizes', () => {
    expect(() =>
      createSafeCaptureResultPayload(captureResultInput({ captureId: '../outside' })),
    ).toThrow('Capture result capture id is invalid.');

    for (const sizeBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createSafeCaptureResultPayload(captureResultInput({ sizeBytes }))).toThrow(
        'Capture result size must be a positive integer.',
      );
    }
  });
});

function captureResultInput(overrides: { captureId?: string; sizeBytes?: number } = {}) {
  return {
    application: { bundleId: 'com.apple.Safari', name: 'Safari' },
    captureId: overrides.captureId ?? 'cap_factory',
    hash: `sha256:${'a'.repeat(64)}`,
    observedAt,
    sizeBytes: overrides.sizeBytes ?? 1024,
  };
}
