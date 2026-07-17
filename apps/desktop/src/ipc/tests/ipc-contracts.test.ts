import { describe, expect, it } from 'bun:test';
import {
  IPC_CHANNEL_REGISTRY,
  IPC_ERROR_CODES,
  assertRendererSafeDto,
  buildPreloadAllowlist,
  createIpcErrorEnvelope,
  validateIpcRequest,
} from '../index';

const FORBIDDEN_PRELOAD_METHODS = [
  'send',
  'invoke',
  'fs',
  'child_process',
  'helperPipe',
  'sqlite',
] as const;

describe('desktop ipc contracts', () => {
  it('defines unique namespaced channels for every runtime capability', () => {
    const channelNames = IPC_CHANNEL_REGISTRY.map((definition) => definition.channel);
    const namespaces = new Set(IPC_CHANNEL_REGISTRY.map((definition) => definition.namespace));

    expect(new Set(channelNames).size).toBe(channelNames.length);
    expect(channelNames.every((channel) => /^[a-z]+[.][a-z][a-zA-Z0-9]*$/.test(channel))).toBe(
      true,
    );
    expect(namespaces).toEqual(
      new Set([
        'session',
        'workspace',
        'capture',
        'sync',
        'ocr',
        'timeline',
        'search',
        'settings',
        'diagnostics',
        'permissions',
        'app',
      ]),
    );
  });

  it('fails validation for invalid request payloads', () => {
    const result = validateIpcRequest('timeline.query', {
      cursor: 'cursor-1',
      limit: 0,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        ok: false,
        error: {
          code: 'validation_failed',
          message: 'Invalid request for timeline.query.',
          details: {
            issues: ['limit must be between 1 and 100 when provided'],
          },
        },
      },
    });
  });

  it('builds a preload allowlist without unsafe generic or platform methods', () => {
    const preloadApi = buildPreloadAllowlist(async () => ({ ok: true, data: undefined }));
    const methodNames = Object.keys(preloadApi);

    expect(methodNames.length).toBeGreaterThan(0);
    expect(methodNames).toContain('timelineQuery');
    expect(methodNames).toContain('diagnosticsGetSafeLogs');

    for (const forbiddenMethod of FORBIDDEN_PRELOAD_METHODS) {
      expect(methodNames).not.toContain(forbiddenMethod);
    }
  });

  it('rejects renderer DTOs with token, path, or raw helper payload fields', () => {
    const safeResult = assertRendererSafeDto({
      id: 'job-1',
      state: 'queued',
      provider: {
        configured: false,
      },
    });

    const unsafeResult = assertRendererSafeDto({
      id: 'job-1',
      authToken: 'secret-token',
      localAbsolutePath: '/Users/example/Pictures/capture.png',
      helperRawPayload: {
        private: true,
      },
    });

    expect(safeResult).toEqual({ ok: true });
    expect(unsafeResult).toEqual({
      ok: false,
      issues: [
        'authToken is not renderer-safe',
        'localAbsolutePath is not renderer-safe',
        'helperRawPayload is not renderer-safe',
      ],
    });
  });

  it('rejects unsafe settings.updateLocal payloads instead of casting broad objects', () => {
    const unsafePayloads = [
      { providerToken: 'provider-token' },
      { authToken: 'auth-token' },
      { localPath: '/Users/example/private/capture.png' },
      { helperRawPayload: { captureId: 'cap_1' } },
      { capture: { enabled: true, unknownNestedKey: true } },
      { diagnostics: { enabled: true, helperRawPayload: { raw: true } } },
    ];

    for (const payload of unsafePayloads) {
      const result = validateIpcRequest('settings.updateLocal', payload);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error.code).toBe('validation_failed');
      }
    }
  });

  it('accepts only the explicit renderer-safe settings.updateLocal schema', () => {
    const result = validateIpcRequest('settings.updateLocal', {
      capture: {
        enabled: true,
        schedule: 'disabled',
      },
      diagnostics: {
        enabled: false,
      },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        capture: {
          enabled: true,
          schedule: 'disabled',
        },
        diagnostics: {
          enabled: false,
        },
      },
    });
  });

  it('keeps error envelopes constrained to typed codes', () => {
    const envelope = createIpcErrorEnvelope('offline', 'Network is offline.');

    expect(IPC_ERROR_CODES).toContain('offline');
    expect(envelope).toEqual({
      ok: false,
      error: {
        code: 'offline',
        message: 'Network is offline.',
      },
    });
  });
});
