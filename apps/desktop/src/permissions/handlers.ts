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
  type PermissionStatusSource,
  readCapturePermissions,
  refreshCapturePermissions,
} from './refresh';

export type PermissionIpcHandlerOptions = {
  client: CaptureHelperCommandClient;
  eventHandler: PermissionStatusSource;
  now(): string;
  privacySettings: PrivacySettingsOpener;
  refreshTimeoutMs?: number;
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
    'permissions.openAccessibilitySettings': async () =>
      createRendererSafeSuccess(await options.privacySettings.open('accessibility')),
    'permissions.openScreenRecordingSettings': async () =>
      createRendererSafeSuccess(await options.privacySettings.open('screen_recording')),
  };
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
