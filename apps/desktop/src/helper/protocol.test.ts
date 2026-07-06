import { describe, expect, it } from 'bun:test';
import {
  HELPER_PROTOCOL_VERSION,
  decodeHelperEnvelopeLine,
  encodeHelperEnvelope,
  parseHelperNdjsonChunk,
} from './protocol';

describe('helper stdio protocol', () => {
  it('encodes and parses helper hello and heartbeat envelopes by NDJSON line', () => {
    const hello = encodeHelperEnvelope({
      protocolVersion: HELPER_PROTOCOL_VERSION,
      messageId: 'msg_hello',
      correlationId: null,
      sentAt: '2026-07-06T00:00:00.000Z',
      type: 'helper.hello',
      payload: {
        helperVersion: 'mock-helper/1.0.0',
        pid: 42,
        capabilities: {
          capture: true,
          permissions: true,
          mock: true,
        },
      },
    });
    const heartbeat = encodeHelperEnvelope({
      protocolVersion: HELPER_PROTOCOL_VERSION,
      messageId: 'msg_heartbeat',
      correlationId: null,
      sentAt: '2026-07-06T00:00:01.000Z',
      type: 'helper.heartbeat',
      payload: {
        sequence: 1,
        status: 'ready',
      },
    });

    const parsed = parseHelperNdjsonChunk(`${hello}${heartbeat}`);

    expect(parsed).toEqual([
      {
        ok: true,
        envelope: {
          protocolVersion: HELPER_PROTOCOL_VERSION,
          messageId: 'msg_hello',
          correlationId: null,
          sentAt: '2026-07-06T00:00:00.000Z',
          type: 'helper.hello',
          payload: {
            helperVersion: 'mock-helper/1.0.0',
            pid: 42,
            capabilities: {
              capture: true,
              permissions: true,
              mock: true,
            },
          },
        },
      },
      {
        ok: true,
        envelope: {
          protocolVersion: HELPER_PROTOCOL_VERSION,
          messageId: 'msg_heartbeat',
          correlationId: null,
          sentAt: '2026-07-06T00:00:01.000Z',
          type: 'helper.heartbeat',
          payload: {
            sequence: 1,
            status: 'ready',
          },
        },
      },
    ]);
  });

  it('fails closed for invalid json without exposing raw payload in the protocol error', () => {
    const result = decodeHelperEnvelopeLine(
      '{"protocolVersion":"recapsy.helper.v1","messageId":"msg_bad","type":"capture.result","payload":{"providerToken":"secret-token"',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: 'invalid_json',
        message: 'Helper protocol line is not valid JSON.',
      });
      expect(JSON.stringify(result.error)).not.toContain('secret-token');
      expect(JSON.stringify(result.error)).not.toContain('providerToken');
    }
  });

  it('fails closed for schema mismatch and does not echo unsafe fields', () => {
    const result = decodeHelperEnvelopeLine(
      JSON.stringify({
        protocolVersion: HELPER_PROTOCOL_VERSION,
        messageId: 'msg_bad_schema',
        correlationId: null,
        sentAt: '2026-07-06T00:00:00.000Z',
        type: 'capture.result',
        payload: {
          captureId: 'cap_1',
          localPath: '/Users/alice/Pictures/private.png',
          axText: 'private document body',
          providerToken: 'provider-token',
        },
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('schema_mismatch');
      expect(JSON.stringify(result.error)).not.toContain('/Users/alice');
      expect(JSON.stringify(result.error)).not.toContain('private document body');
      expect(JSON.stringify(result.error)).not.toContain('provider-token');
    }
  });

  it('fails closed for schema-valid capture context strings that expose local paths or secrets', () => {
    const unsafeContextVariants = [
      {
        window: {
          title: '/Users/alice/Documents/private.txt',
        },
      },
      {
        document: {
          name: 'file://Users/alice/Documents/private.txt',
        },
      },
      {
        website: {
          origin: 'https://example.com/path?token=secret',
          host: 'example.com',
        },
      },
      {
        window: {
          title: 'OpenAI key sk-1234567890abcdef1234567890abcdef',
        },
      },
      {
        axText: 'private selected text',
      },
    ];

    for (const contextVariant of unsafeContextVariants) {
      const result = decodeHelperEnvelopeLine(
        JSON.stringify({
          protocolVersion: HELPER_PROTOCOL_VERSION,
          messageId: 'msg_unsafe_context',
          correlationId: null,
          sentAt: '2026-07-06T00:00:00.000Z',
          type: 'capture.result',
          payload: buildCaptureResultPayload(contextVariant),
        }),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('schema_mismatch');
        expect(JSON.stringify(result.error)).not.toContain('/Users/alice');
        expect(JSON.stringify(result.error)).not.toContain('file://');
        expect(JSON.stringify(result.error)).not.toContain('token=secret');
        expect(JSON.stringify(result.error)).not.toContain('sk-');
        expect(JSON.stringify(result.error)).not.toContain('private selected text');
      }
    }
  });

  it('accepts safe capture context basename, window title, and website origin', () => {
    const result = decodeHelperEnvelopeLine(
      JSON.stringify({
        protocolVersion: HELPER_PROTOCOL_VERSION,
        messageId: 'msg_safe_context',
        correlationId: null,
        sentAt: '2026-07-06T00:00:00.000Z',
        type: 'capture.result',
        payload: buildCaptureResultPayload({
          window: {
            title: 'Quarterly Planning',
          },
          website: {
            origin: 'https://example.com',
            host: 'example.com',
          },
          document: {
            name: 'notes.md',
          },
        }),
      }),
    );

    expect(result.ok).toBe(true);
  });
});

function buildCaptureResultPayload(context: Record<string, unknown>) {
  return {
    captureId: 'cap_1',
    observedAt: '2026-07-06T00:00:00.000Z',
    manifest: {
      role: 'manifest',
      ref: 'opaque:manifest:cap_1',
      hash: 'sha256:manifest',
      mimeType: 'application/json',
      sizeBytes: 0,
    },
    assets: [
      {
        role: 'screenshot',
        ref: 'opaque:asset:cap_1',
        hash: 'sha256:asset',
        mimeType: 'image/png',
        sizeBytes: 1,
      },
    ],
    context: {
      observedAt: '2026-07-06T00:00:00.000Z',
      ...context,
      policy: {
        version: 'policy-v1',
        decision: 'allow',
      },
    },
  };
}
