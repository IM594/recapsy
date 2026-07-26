import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import {
  IPC_CHANNEL_REGISTRY,
  IPC_ERROR_CODES,
  assertRendererSafeDto,
  buildPreloadAllowlist,
  createIpcErrorEnvelope,
  registerIpcHandlers,
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
  it('defines only the channels used by the current desktop renderer', () => {
    const channelNames = IPC_CHANNEL_REGISTRY.map((definition) => definition.channel);
    const namespaces = new Set(IPC_CHANNEL_REGISTRY.map((definition) => definition.namespace));

    expect(new Set(channelNames).size).toBe(channelNames.length);
    expect(channelNames.every((channel) => /^[a-z]+[.][a-z][a-zA-Z0-9]*$/.test(channel))).toBe(
      true,
    );
    expect(channelNames).toEqual([
      'capture.getStatus',
      'capture.listLocalRules',
      'capture.blockBundle',
      'capture.removeLocalRule',
      'capture.pause',
      'capture.resume',
      'sync.getSummary',
      'sync.resume',
      'sync.requeueTerminal',
      'diagnostics.previewRetention',
      'diagnostics.runRetention',
      'permissions.getStatus',
      'permissions.refresh',
      'permissions.requestScreenRecording',
      'permissions.openScreenRecordingSettings',
      'permissions.openAccessibilitySettings',
    ]);
    expect(namespaces).toEqual(new Set(['capture', 'sync', 'diagnostics', 'permissions']));
  });

  it('fails validation for invalid request payloads', () => {
    const result = validateIpcRequest('capture.blockBundle', {
      bundleId: 'https://example.com/login',
    });

    expect(result).toEqual({
      ok: false,
      error: {
        ok: false,
        error: {
          code: 'validation_failed',
          message: 'Invalid request for capture.blockBundle.',
          details: {
            issues: ['bundleId must be an exact application bundle identifier'],
          },
        },
      },
    });
  });

  it('builds a preload allowlist without unsafe generic or platform methods', () => {
    const preloadApi = buildPreloadAllowlist(async () => ({ ok: true, data: undefined }));
    const methodNames = Object.keys(preloadApi);

    expect(methodNames).toEqual([
      'captureGetStatus',
      'captureListLocalRules',
      'captureBlockBundle',
      'captureRemoveLocalRule',
      'capturePause',
      'captureResume',
      'syncGetSummary',
      'syncResume',
      'syncRequeueTerminal',
      'diagnosticsPreviewRetention',
      'diagnosticsRunRetention',
      'permissionsGetStatus',
      'permissionsRefresh',
      'permissionsRequestScreenRecording',
      'permissionsOpenScreenRecordingSettings',
      'permissionsOpenAccessibilitySettings',
    ]);

    for (const forbiddenMethod of FORBIDDEN_PRELOAD_METHODS) {
      expect(methodNames).not.toContain(forbiddenMethod);
    }
  });

  it('keeps the explicit retention cleanup action reachable from the current renderer', async () => {
    const renderer = await readFile(
      new URL('../../shell/main-window.html', import.meta.url),
      'utf8',
    );

    expect(renderer).toContain('id="retention-clean"');
    expect(renderer).toContain('api.diagnosticsRunRetention({ olderThanDays: 30 })');
  });

  it('keeps provider-sync recovery actions reachable from the current renderer', async () => {
    const renderer = await readFile(
      new URL('../../shell/main-window.html', import.meta.url),
      'utf8',
    );

    expect(renderer).toContain('api.syncResume()');
    expect(renderer).toContain('api.syncRequeueTerminal()');
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

  it('fails before registering any channel when an active handler is missing', () => {
    const registeredChannels: string[] = [];

    expect(() =>
      registerIpcHandlers(
        {
          handle(channel) {
            registeredChannels.push(channel);
          },
        },
        {},
      ),
    ).toThrow('Missing IPC handlers for active channels: capture.getStatus');
    expect(registeredChannels).toEqual([]);
  });

  it('accepts a bounded retention-preview request without exposing local paths', () => {
    expect(validateIpcRequest('diagnostics.previewRetention', { olderThanDays: 30 })).toEqual({
      ok: true,
      value: { olderThanDays: 30 },
    });
    expect(validateIpcRequest('diagnostics.previewRetention', { olderThanDays: 0 })).toMatchObject({
      ok: false,
    });
  });

  it('accepts the same bounded request for an explicit retention execution', () => {
    expect(validateIpcRequest('diagnostics.runRetention', { olderThanDays: 30 })).toEqual({
      ok: true,
      value: { olderThanDays: 30 },
    });
    expect(validateIpcRequest('diagnostics.runRetention', { olderThanDays: 0 })).toMatchObject({
      ok: false,
    });
  });

  it('accepts only exact bundle identifiers for local capture blocks', () => {
    expect(
      validateIpcRequest('capture.blockBundle', { bundleId: 'com.example.PasswordManager' }),
    ).toEqual({
      ok: true,
      value: { bundleId: 'com.example.PasswordManager' },
    });
    expect(
      validateIpcRequest('capture.blockBundle', { bundleId: 'https://example.com/login' }),
    ).toMatchObject({
      ok: false,
    });
    expect(validateIpcRequest('capture.removeLocalRule', { ruleId: 'local:abc123' })).toEqual({
      ok: true,
      value: { ruleId: 'local:abc123' },
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
