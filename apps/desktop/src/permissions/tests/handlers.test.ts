import { describe, expect, it } from 'bun:test';
import { createPermissionIpcHandlers } from '../handlers';

describe('permission IPC handlers', () => {
  it('returns permission status and opens privacy panes', async () => {
    const opened: string[] = [];
    const handlers = createPermissionIpcHandlers({
      client: {
        async sendCommand() {},
      },
      eventHandler: {
        getStatus: () => ({
          lastObservedAt: '2026-07-16T00:00:00.000Z',
          permissions: {
            accessibility: 'not_determined',
            screenRecording: 'denied',
          },
        }),
        subscribeToPermissionStatus: () => () => undefined,
      },
      now: () => '2026-07-16T00:00:00.000Z',
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

  it('returns a fixed safe error when refresh receives no newer permission observation', async () => {
    const handlers = createPermissionIpcHandlers({
      client: {
        async sendCommand() {},
      },
      eventHandler: {
        getStatus: () => ({
          lastObservedAt: '2026-07-16T00:00:00.000Z',
          permissions: {
            accessibility: 'granted',
            screenRecording: 'granted',
          },
          permissionStatusSequence: 1,
        }),
        subscribeToPermissionStatus: () => () => undefined,
      },
      now: () => '2026-07-16T00:00:00.000Z',
      privacySettings: {
        async open() {
          return { opened: true as const };
        },
      },
      refreshTimeoutMs: 0,
    });

    const response = await handlers['permissions.refresh']?.({});

    expect(response).toEqual({
      error: {
        code: 'permission_refresh_timeout',
        message: 'Permission refresh timed out.',
      },
      ok: false,
    });
    expect(JSON.stringify(response)).not.toContain('/Users');
    expect(JSON.stringify(response)).not.toContain('permissionStatusSequence');
  });

  it('returns a distinct fixed safe error when an explicit request receives no status observation', async () => {
    const handlers = createPermissionIpcHandlers({
      client: {
        async sendCommand() {},
      },
      eventHandler: {
        getStatus: () => ({
          permissions: {
            accessibility: 'not_determined',
            screenRecording: 'not_determined',
          },
          permissionStatusSequence: 1,
        }),
        subscribeToPermissionStatus: () => () => undefined,
      },
      now: () => '2026-07-16T00:00:00.000Z',
      privacySettings: {
        async open() {
          return { opened: true as const };
        },
      },
      screenRecordingRequestTimeoutMs: 0,
    });

    await expect(handlers['permissions.requestScreenRecording']?.({})).resolves.toEqual({
      error: {
        code: 'permission_request_timeout',
        message: 'Screen Recording permission request timed out.',
      },
      ok: false,
    });
  });

  it('returns a fixed safe error when the permission command cannot be sent', async () => {
    const handlers = createPermissionIpcHandlers({
      client: {
        async sendCommand() {
          throw new Error('/private/var/folders/secret/permission-command');
        },
      },
      eventHandler: {
        getStatus: () => ({}),
        subscribeToPermissionStatus: () => () => undefined,
      },
      now: () => '2026-07-16T00:00:00.000Z',
      privacySettings: {
        async open() {
          return { opened: true as const };
        },
      },
    });

    const response = await handlers['permissions.refresh']?.({});

    expect(response).toEqual({
      error: {
        code: 'permission_refresh_unavailable',
        message: 'Permission refresh is unavailable.',
      },
      ok: false,
    });
    expect(JSON.stringify(response)).not.toContain('/private');
  });

  it('forwards only an explicit renderer action to the screen-recording request command', async () => {
    const commands: unknown[] = [];
    let permissionStatusSequence = 7;
    let listener:
      | ((status: {
          permissions?: { accessibility: 'not_determined'; screenRecording: 'granted' };
          permissionStatusSequence?: number;
        }) => void)
      | undefined;
    const permissions = {
      accessibility: 'not_determined' as const,
      screenRecording: 'granted' as const,
    };
    const handlers = createPermissionIpcHandlers({
      client: {
        async sendCommand(command) {
          commands.push(command);
          permissionStatusSequence += 1;
          listener?.({ permissions, permissionStatusSequence });
        },
      },
      eventHandler: {
        getStatus: () => ({ permissions, permissionStatusSequence }),
        subscribeToPermissionStatus(next) {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      },
      now: () => '2026-07-17T12:00:00.000Z',
      privacySettings: {
        async open() {
          return { opened: true as const };
        },
      },
    });

    await expect(handlers['permissions.requestScreenRecording']?.({})).resolves.toEqual({
      data: {
        accessibility: 'not_determined',
        accessibilityRequired: true,
        screenRecording: 'granted',
        screenRecordingRequired: false,
      },
      ok: true,
    });
    expect(commands).toMatchObject([{ type: 'permission.request_screen_capture' }]);
  });
});
