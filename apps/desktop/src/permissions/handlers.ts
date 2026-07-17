import type { CaptureHelperCommandClient } from '../helper/index';
import {
  type IpcHandlerMap,
  type PermissionStatusDto,
  createIpcErrorEnvelope,
  createRendererSafeSuccess,
} from '../ipc/index';
import type { PrivacySettingsOpener } from './privacy-settings';
import {
  PermissionRefreshError,
  PermissionRequestError,
  type PermissionStatusSource,
  readCapturePermissions,
  refreshCapturePermissions,
  requestScreenRecordingPermission,
} from './refresh';

export type PermissionIpcHandlerOptions = {
  client: CaptureHelperCommandClient;
  eventHandler: PermissionStatusSource;
  now(): string;
  privacySettings: PrivacySettingsOpener;
  refreshTimeoutMs?: number;
  screenRecordingRequestTimeoutMs?: number;
};

export function createPermissionIpcHandlers(options: PermissionIpcHandlerOptions): IpcHandlerMap {
  return {
    'permissions.getStatus': async () =>
      createRendererSafeSuccess(
        toPermissionStatusDto(readCapturePermissions(options.eventHandler)),
      ),
    'permissions.refresh': async () => {
      try {
        const permissions = await refreshCapturePermissions({
          client: options.client,
          eventHandler: options.eventHandler,
          now: options.now,
          timeoutMs: options.refreshTimeoutMs,
        });
        return createRendererSafeSuccess(toPermissionStatusDto(permissions));
      } catch (error) {
        return createPermissionRefreshErrorEnvelope(error);
      }
    },
    'permissions.requestScreenRecording': async () => {
      try {
        const permissions = await requestScreenRecordingPermission({
          client: options.client,
          eventHandler: options.eventHandler,
          now: options.now,
          timeoutMs: options.screenRecordingRequestTimeoutMs,
        });
        return createRendererSafeSuccess(toPermissionStatusDto(permissions));
      } catch (error) {
        return createPermissionRequestErrorEnvelope(error);
      }
    },
    'permissions.openAccessibilitySettings': async () =>
      createRendererSafeSuccess(await options.privacySettings.open('accessibility')),
    'permissions.openScreenRecordingSettings': async () =>
      createRendererSafeSuccess(await options.privacySettings.open('screen_recording')),
  };
}

function createPermissionRequestErrorEnvelope(error: unknown) {
  if (error instanceof PermissionRequestError && error.code === 'permission_request_timeout') {
    return createIpcErrorEnvelope(
      'permission_request_timeout',
      'Screen Recording permission request timed out.',
    );
  }

  return createIpcErrorEnvelope(
    'permission_request_unavailable',
    'Screen Recording permission request is unavailable.',
  );
}

function createPermissionRefreshErrorEnvelope(error: unknown) {
  if (error instanceof PermissionRefreshError && error.code === 'permission_refresh_timeout') {
    return createIpcErrorEnvelope('permission_refresh_timeout', 'Permission refresh timed out.');
  }

  return createIpcErrorEnvelope(
    'permission_refresh_unavailable',
    'Permission refresh is unavailable.',
  );
}

function toPermissionStatusDto(permissions: {
  screenRecording: PermissionStatusDto['screenRecording'];
  accessibility: PermissionStatusDto['accessibility'];
}): PermissionStatusDto {
  return {
    accessibility: permissions.accessibility,
    accessibilityRequired: permissions.accessibility !== 'granted',
    screenRecording: permissions.screenRecording,
    screenRecordingRequired: permissions.screenRecording !== 'granted',
  };
}
