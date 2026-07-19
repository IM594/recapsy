import { type CaptureHelperCommandClient, HelperPermissionCommandError } from '../helper/index';

export type PermissionSnapshot = {
  screenRecording: 'granted' | 'denied' | 'not_determined' | 'unknown';
  accessibility: 'granted' | 'denied' | 'not_determined' | 'unknown';
};

export type PermissionStatusSource = {
  getSnapshot(): { permissions?: PermissionSnapshot };
};

export type RefreshCapturePermissionsOptions = {
  client: CaptureHelperCommandClient;
  timeoutMs?: number;
};

export type RequestScreenRecordingPermissionOptions = RefreshCapturePermissionsOptions;

export const PERMISSION_REFRESH_ERROR_CODES = [
  'permission_refresh_timeout',
  'permission_refresh_unavailable',
] as const;

export type PermissionRefreshErrorCode = (typeof PERMISSION_REFRESH_ERROR_CODES)[number];

export const PERMISSION_REQUEST_ERROR_CODES = [
  'permission_request_timeout',
  'permission_request_unavailable',
] as const;

export type PermissionRequestErrorCode = (typeof PERMISSION_REQUEST_ERROR_CODES)[number];

export class PermissionRefreshError extends Error {
  constructor(public readonly code: PermissionRefreshErrorCode) {
    super(
      code === 'permission_refresh_timeout'
        ? 'Permission refresh timed out.'
        : 'Permission refresh is unavailable.',
    );
    this.name = 'PermissionRefreshError';
  }
}

export class PermissionRequestError extends Error {
  constructor(public readonly code: PermissionRequestErrorCode) {
    super(
      code === 'permission_request_timeout'
        ? 'Screen Recording permission request timed out.'
        : 'Screen Recording permission request is unavailable.',
    );
    this.name = 'PermissionRequestError';
  }
}

export async function refreshCapturePermissions(
  options: RefreshCapturePermissionsOptions,
): Promise<PermissionSnapshot> {
  try {
    return await options.client.refreshPermissions({ timeoutMs: options.timeoutMs });
  } catch (error) {
    throw new PermissionRefreshError(
      error instanceof HelperPermissionCommandError
        ? 'permission_refresh_timeout'
        : 'permission_refresh_unavailable',
    );
  }
}

export async function requestScreenRecordingPermission(
  options: RequestScreenRecordingPermissionOptions,
): Promise<PermissionSnapshot> {
  try {
    return await options.client.requestScreenRecordingPermission({ timeoutMs: options.timeoutMs });
  } catch (error) {
    throw new PermissionRequestError(
      error instanceof HelperPermissionCommandError
        ? 'permission_request_timeout'
        : 'permission_request_unavailable',
    );
  }
}

export function readCapturePermissions(statusSource: PermissionStatusSource): PermissionSnapshot {
  return (
    statusSource.getSnapshot().permissions ?? {
      accessibility: 'unknown',
      screenRecording: 'unknown',
    }
  );
}
