import { describe, expect, it } from 'bun:test';
import {
  classifySyncError,
  isLocalAssetSyncErrorCode,
  isTerminalBlockingSyncErrorCode,
  syncSafeMessage,
  toSyncPresentationError,
} from '../errors';

describe('sync error classification', () => {
  it('honors transport retry decisions without serializing HTTP or untrusted details', () => {
    const leakedText = 'Bearer sk-provider-secret /Users/alice/private.png Patient Magnolia';
    const cases = [
      {
        error: {
          code: 'provider_rate_limited',
          details: { responseBody: leakedText },
          retryable: true,
          safeMessage: leakedText,
          status: 429,
        },
        expected: { code: 'provider_rate_limited', retryable: true },
      },
      {
        error: {
          code: 'server_unavailable',
          retryable: true,
          safeMessage: leakedText,
          status: 503,
        },
        expected: { code: 'server_unavailable', retryable: true },
      },
      {
        error: {
          code: 'validation_failed',
          retryable: false,
          safeMessage: leakedText,
          status: 400,
        },
        expected: { code: 'validation_failed', retryable: false },
      },
      {
        error: {
          code: 'provider_auth_failed',
          retryable: false,
          safeMessage: leakedText,
          status: 503,
        },
        expected: { code: 'provider_auth_failed', retryable: false },
      },
    ] as const;

    for (const testCase of cases) {
      const classified = classifySyncError(testCase.error);

      expect(classified).toEqual(testCase.expected);
      expect(JSON.stringify(classified)).not.toContain(leakedText);
      expect(classified).not.toHaveProperty('safeMessage');
      expect(classified).not.toHaveProperty('status');
      expect(classified).not.toHaveProperty('details');
    }
  });

  it('classifies Error and non-Error values with the existing fail-closed boundaries', () => {
    const offlineError = Object.assign(new Error('socket closed'), { code: 'offline' });
    const localAssetError = Object.assign(new Error('asset unavailable'), {
      code: 'local_asset_unreadable',
    });
    const localDatabaseError = new Error('SQLITE_BUSY: database is locked');

    expect(classifySyncError(offlineError)).toEqual({ code: 'offline', retryable: true });
    expect(classifySyncError(localAssetError)).toEqual({
      code: 'local_asset_unreadable',
      retryable: false,
    });
    expect(classifySyncError(localDatabaseError)).toEqual({
      code: 'server_unavailable',
      retryable: true,
    });

    for (const error of [
      new SyntaxError('unexpected token'),
      new TypeError('invalid payload'),
      new Error('Bearer secret should not survive'),
      'plain rejection',
      { message: 'object rejection' },
      null,
    ]) {
      expect(classifySyncError(error)).toEqual({
        code: 'validation_failed',
        retryable: false,
      });
    }
  });

  it('keeps blocking and local asset code policy explicit', () => {
    expect(isTerminalBlockingSyncErrorCode('policy_denied')).toBe(true);
    expect(isTerminalBlockingSyncErrorCode('provider_not_configured')).toBe(true);
    expect(isTerminalBlockingSyncErrorCode('quota_exceeded')).toBe(true);
    expect(isTerminalBlockingSyncErrorCode('provider_unavailable')).toBe(false);
    expect(isTerminalBlockingSyncErrorCode('input_too_large')).toBe(false);

    expect(isLocalAssetSyncErrorCode('local_asset_missing')).toBe(true);
    expect(isLocalAssetSyncErrorCode('local_asset_unreadable')).toBe(true);
    expect(isLocalAssetSyncErrorCode('asset_ref_missing')).toBe(false);
    expect(isLocalAssetSyncErrorCode('server_unavailable')).toBe(false);
  });

  it('derives canonical persisted messages only from safe codes', () => {
    expect(syncSafeMessage('offline')).toBe('Network is offline or unavailable.');
    expect(syncSafeMessage('provider_timeout')).toBe('OCR provider timed out.');
    expect(syncSafeMessage('local_asset_missing')).toBe('Local asset is missing.');
    expect(syncSafeMessage('unrecognized_internal_code')).toBe('Sync failed.');
  });
});

describe('sync presentation errors', () => {
  it('maps internal codes to renderer-safe summaries without leaking persisted messages', () => {
    const leakedText = 'Bearer sk-provider-secret /Users/alice/private.png Patient Magnolia';
    const cases = [
      {
        code: 'provider_timeout',
        expected: {
          code: 'provider_unavailable',
          details: { safeCode: 'provider_timeout' },
          message: 'OCR provider timed out.',
        },
      },
      {
        code: 'local_asset_missing',
        expected: {
          code: 'validation_failed',
          details: { safeCode: 'local_asset_missing' },
          message: 'Local asset is missing.',
        },
      },
      {
        code: 'policy_denied',
        expected: {
          code: 'policy_denied',
          message: 'Capture policy denied this request.',
        },
      },
      {
        code: 'unrecognized_internal_code',
        expected: {
          code: 'unknown',
          details: { safeCode: 'unrecognized_internal_code' },
          message: 'Sync failed.',
        },
      },
    ] as const;

    for (const testCase of cases) {
      const presentationError = toSyncPresentationError({
        code: testCase.code,
        message: leakedText,
        retryable: false,
      });

      expect(presentationError).toEqual(testCase.expected);
      expect(JSON.stringify(presentationError)).not.toContain(leakedText);
    }
  });
});
