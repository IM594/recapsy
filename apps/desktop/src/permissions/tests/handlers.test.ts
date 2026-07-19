import { describe, expect, it } from 'bun:test';
import {
  type CaptureHelperCommandClient,
  HelperPermissionCommandError,
  type HelperPermissionSnapshot,
} from '../../helper/index';
import { createPermissionIpcHandlers } from '../handlers';

const grantedPermissions: HelperPermissionSnapshot = {
  accessibility: 'granted',
  screenRecording: 'granted',
};

describe('permission IPC handlers', () => {
  it('returns permission facts and opens privacy panes', async () => {
    const opened: string[] = [];
    const handlers = createPermissionIpcHandlers({
      client: createCommandClient(),
      statusSource: {
        getSnapshot: () => ({
          permissions: { accessibility: 'not_determined', screenRecording: 'denied' },
        }),
      },
      privacySettings: {
        async open(pane) {
          opened.push(pane);
          return { opened: true as const };
        },
      },
    });

    await expect(handlers['permissions.getStatus']?.({})).resolves.toEqual({
      data: {
        accessibility: 'not_determined',
        accessibilityRequired: true,
        screenRecording: 'denied',
        screenRecordingRequired: true,
      },
      ok: true,
    });
    await expect(handlers['permissions.openScreenRecordingSettings']?.({})).resolves.toEqual({
      data: { opened: true },
      ok: true,
    });
    await expect(handlers['permissions.openAccessibilitySettings']?.({})).resolves.toEqual({
      data: { opened: true },
      ok: true,
    });
    expect(opened).toEqual(['screen_recording', 'accessibility']);
  });

  it('maps the helper refresh timeout without exposing implementation details', async () => {
    const handlers = createPermissionIpcHandlers({
      client: createCommandClient({
        refreshPermissions: async () => {
          throw new HelperPermissionCommandError('permission_timeout');
        },
      }),
      statusSource: { getSnapshot: () => ({}) },
      privacySettings: {
        async open() {
          return { opened: true as const };
        },
      },
    });

    const response = await handlers['permissions.refresh']?.({});
    expect(response).toEqual({
      error: {
        code: 'permission_refresh_timeout',
        message: 'Permission refresh timed out.',
      },
      ok: false,
    });
    expect(JSON.stringify(response)).not.toContain('correlationId');
  });

  it('maps the explicit request timeout independently from refresh', async () => {
    const handlers = createPermissionIpcHandlers({
      client: createCommandClient({
        requestScreenRecordingPermission: async () => {
          throw new HelperPermissionCommandError('permission_timeout');
        },
      }),
      statusSource: { getSnapshot: () => ({}) },
      privacySettings: {
        async open() {
          return { opened: true as const };
        },
      },
    });

    await expect(handlers['permissions.requestScreenRecording']?.({})).resolves.toEqual({
      error: {
        code: 'permission_request_timeout',
        message: 'Screen Recording permission request timed out.',
      },
      ok: false,
    });
  });

  it('uses the helper-owned request command for an explicit renderer action', async () => {
    const requests: Array<number | undefined> = [];
    const handlers = createPermissionIpcHandlers({
      client: createCommandClient({
        requestScreenRecordingPermission: async ({ timeoutMs } = {}) => {
          requests.push(timeoutMs);
          return grantedPermissions;
        },
      }),
      screenRecordingRequestTimeoutMs: 60_000,
      statusSource: { getSnapshot: () => ({}) },
      privacySettings: {
        async open() {
          return { opened: true as const };
        },
      },
    });

    await expect(handlers['permissions.requestScreenRecording']?.({})).resolves.toEqual({
      data: {
        accessibility: 'granted',
        accessibilityRequired: false,
        screenRecording: 'granted',
        screenRecordingRequired: false,
      },
      ok: true,
    });
    expect(requests).toEqual([60_000]);
  });
});

function createCommandClient(
  overrides: Partial<
    Pick<CaptureHelperCommandClient, 'refreshPermissions' | 'requestScreenRecordingPermission'>
  > = {},
): CaptureHelperCommandClient {
  return {
    async sendCommand() {},
    refreshPermissions: async () => grantedPermissions,
    requestScreenRecordingPermission: async () => grantedPermissions,
    ...overrides,
  };
}
