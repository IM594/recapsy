import type { SafeOperationalError } from '../storage/index';
import type { SyncPresentationErrorCode, SyncQueueSummary } from './types';

export type ClassifiedSyncError = {
  code: string;
  retryable: boolean;
};

const TERMINAL_BLOCKING_SYNC_ERROR_CODES = new Set([
  'policy_denied',
  'provider_not_configured',
  'quota_exceeded',
]);

const LOCAL_ASSET_SYNC_ERROR_CODES = new Set(['local_asset_missing', 'local_asset_unreadable']);

const CLASSIFIABLE_SYNC_ERROR_CODES = new Set([
  'offline',
  'server_unavailable',
  'validation_failed',
  'workspace_required',
  'unknown',
  'result_invalid',
]);

const RETRYABLE_SYNC_ERROR_CODES = new Set(['offline', 'server_unavailable', 'unknown']);

const SYNC_SAFE_MESSAGES: Record<string, string> = {
  unauthenticated: 'Authentication is required.',
  workspace_required: 'Workspace is required.',
  offline: 'Network is offline or unavailable.',
  server_unavailable: 'Server is unavailable.',
  policy_denied: 'Capture policy denied this request.',
  quota_exceeded: 'Quota has been exceeded.',
  provider_not_configured: 'Provider is not configured.',
  provider_unavailable: 'Provider is unavailable.',
  provider_auth_failed: 'Provider authentication failed.',
  provider_rate_limited: 'Provider is rate limited.',
  ocr_concurrency_limited: 'Too many concurrent OCR requests.',
  provider_timeout: 'OCR provider timed out.',
  operation_in_progress: 'OCR operation is still processing.',
  operation_conflict: 'OCR operation key conflicts with this image.',
  input_too_large: 'Input is too large.',
  unsupported_format: 'Input format is unsupported.',
  validation_failed: 'Request validation failed.',
  result_invalid: 'OCR result is invalid.',
  unknown: 'Sync failed due to an unexpected error.',
  local_asset_missing: 'Local asset is missing.',
  local_asset_unreadable: 'Local asset is unreadable.',
  asset_ref_missing: 'Local asset reference is missing.',
  upload_input_missing: 'Upload input asset is missing.',
  cancelled: 'Request was cancelled.',
};

export function classifySyncError(error: unknown): ClassifiedSyncError {
  if (isSafeErrorShape(error)) {
    return { code: error.code, retryable: error.retryable };
  }

  if (error instanceof SyntaxError || error instanceof TypeError) {
    return { code: 'validation_failed', retryable: false };
  }

  if (error instanceof Error) {
    const code = errorCode(error);
    if (code) {
      if (isLocalAssetSyncErrorCode(code)) {
        return { code, retryable: false };
      }

      if (CLASSIFIABLE_SYNC_ERROR_CODES.has(code)) {
        return { code, retryable: RETRYABLE_SYNC_ERROR_CODES.has(code) };
      }
    }

    const message = error.message.toLowerCase();
    if (message.includes('sqlite') || message.includes('database')) {
      return { code: 'server_unavailable', retryable: true };
    }
  }

  return { code: 'validation_failed', retryable: false };
}

export function isTerminalBlockingSyncErrorCode(code: string): boolean {
  return TERMINAL_BLOCKING_SYNC_ERROR_CODES.has(code);
}

export function isLocalAssetSyncErrorCode(code: string): boolean {
  return LOCAL_ASSET_SYNC_ERROR_CODES.has(code);
}

export function syncSafeMessage(code: string): string {
  return SYNC_SAFE_MESSAGES[code] ?? 'Sync failed.';
}

export function toSyncPresentationError(
  error: SafeOperationalError,
): NonNullable<SyncQueueSummary['lastError']> {
  const code = toPresentationErrorCode(error.code);
  const details =
    code !== error.code
      ? {
          safeCode: error.code,
        }
      : undefined;

  return {
    code,
    message: syncSafeMessage(error.code),
    ...(details ? { details } : {}),
  };
}

function isSafeErrorShape(
  error: unknown,
): error is { code: string; safeMessage: string; retryable: boolean } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'safeMessage' in error &&
    'retryable' in error &&
    typeof error.code === 'string' &&
    typeof error.safeMessage === 'string' &&
    typeof error.retryable === 'boolean'
  );
}

function errorCode(error: Error): string | null {
  if (!('code' in error) || typeof error.code !== 'string' || error.code.length === 0) {
    return null;
  }
  return error.code;
}

function toPresentationErrorCode(code: string): SyncPresentationErrorCode {
  if (code === 'provider_rate_limited' || code === 'provider_timeout') {
    return 'provider_unavailable';
  }

  if (isSyncPresentationErrorCode(code)) {
    return code;
  }

  if (
    code === 'local_asset_missing' ||
    code === 'local_asset_unreadable' ||
    code === 'asset_ref_missing' ||
    code === 'upload_input_missing'
  ) {
    return 'validation_failed';
  }

  return 'unknown';
}

function isSyncPresentationErrorCode(code: string): code is SyncPresentationErrorCode {
  switch (code) {
    case 'unauthenticated':
    case 'workspace_required':
    case 'offline':
    case 'server_unavailable':
    case 'policy_denied':
    case 'quota_exceeded':
    case 'provider_not_configured':
    case 'provider_unavailable':
    case 'input_too_large':
    case 'unsupported_format':
    case 'validation_failed':
    case 'result_invalid':
    case 'cancelled':
    case 'unknown':
      return true;
    default:
      return false;
  }
}
