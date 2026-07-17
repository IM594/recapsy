import { describe, expect, it } from 'bun:test';
import {
  HELPER_PROTOCOL_VERSION,
  type HelperEnvelope,
  type MainToHelperType,
} from '../../helper/index';
import {
  PermissionRefreshError,
  type PermissionSnapshot,
  readCapturePermissions,
  refreshCapturePermissions,
} from '../refresh';

describe('capture permission refresh', () => {
  it('reads unknown permissions when the helper has not reported yet', () => {
    expect(
      readCapturePermissions({
        getStatus: () => ({}),
        subscribeToPermissionStatus: () => () => undefined,
      }),
    ).toEqual({
      accessibility: 'unknown',
      screenRecording: 'unknown',
    });
  });

  it('sends permission.refresh and waits for a newer observation', async () => {
    const commands: HelperEnvelope<MainToHelperType>[] = [];
    let observedAt = '2026-07-16T00:00:00.000Z';
    let permissionStatusSequence = 1;
    let permissions: {
      accessibility: 'granted' | 'denied' | 'not_determined' | 'unknown';
      screenRecording: 'granted' | 'denied' | 'not_determined' | 'unknown';
    } = {
      accessibility: 'not_determined',
      screenRecording: 'not_determined',
    };
    let listener:
      | ((status: {
          lastObservedAt?: string;
          permissions?: PermissionSnapshot;
          permissionStatusSequence?: number;
        }) => void)
      | undefined;

    const refreshPromise = refreshCapturePermissions({
      client: {
        async sendCommand(command) {
          commands.push(command);
          observedAt = '2026-07-16T00:00:01.000Z';
          permissions = {
            accessibility: 'granted',
            screenRecording: 'granted',
          };
          permissionStatusSequence += 1;
          listener?.({
            lastObservedAt: observedAt,
            permissions,
            permissionStatusSequence,
          });
        },
      },
      eventHandler: {
        getStatus: () => ({
          lastObservedAt: observedAt,
          permissions,
          permissionStatusSequence,
        }),
        subscribeToPermissionStatus(next) {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      },
      now: () => '2026-07-16T00:00:00.500Z',
      timeoutMs: 200,
    });

    await expect(refreshPromise).resolves.toEqual({
      accessibility: 'granted',
      screenRecording: 'granted',
    });
    expect(commands).toEqual([
      {
        correlationId: null,
        messageId: 'permission-refresh-2026-07-16T00:00:00.500Z',
        payload: {},
        protocolVersion: HELPER_PROTOCOL_VERSION,
        sentAt: '2026-07-16T00:00:00.500Z',
        type: 'permission.refresh',
      },
    ]);
  });

  it('ignores unrelated helper observations until a new permission.status arrives', async () => {
    let lastObservedAt = '2026-07-16T00:00:00.000Z';
    let permissionStatusSequence = 1;
    let permissions: PermissionSnapshot = {
      accessibility: 'not_determined',
      screenRecording: 'denied',
    };
    let listener:
      | ((status: {
          lastObservedAt?: string;
          permissions?: PermissionSnapshot;
          permissionStatusSequence?: number;
        }) => void)
      | undefined;

    const refreshedPermissions = refreshCapturePermissions({
      client: {
        async sendCommand() {
          lastObservedAt = '2026-07-16T00:00:01.000Z';
          listener?.({
            lastObservedAt,
            permissions,
            permissionStatusSequence,
          });

          permissionStatusSequence += 1;
          lastObservedAt = '2026-07-16T00:00:02.000Z';
          permissions = {
            accessibility: 'granted',
            screenRecording: 'granted',
          };
          listener?.({
            lastObservedAt,
            permissions,
            permissionStatusSequence,
          });
        },
      },
      eventHandler: {
        getStatus: () => ({
          lastObservedAt,
          permissions,
          permissionStatusSequence,
        }),
        subscribeToPermissionStatus(next) {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      },
      now: () => '2026-07-16T00:00:00.500Z',
      timeoutMs: 200,
    });

    await expect(refreshedPermissions).resolves.toEqual({
      accessibility: 'granted',
      screenRecording: 'granted',
    });
  });

  it('rejects with a typed timeout instead of returning cached permissions', async () => {
    const refresh = refreshCapturePermissions({
      client: {
        async sendCommand() {},
      },
      eventHandler: {
        getStatus: () => ({
          permissions: {
            accessibility: 'granted',
            screenRecording: 'granted',
          },
          permissionStatusSequence: 1,
        }),
        subscribeToPermissionStatus: () => () => undefined,
      },
      now: () => '2026-07-16T00:00:00.500Z',
      timeoutMs: 0,
    });

    await expect(refresh).rejects.toEqual(new PermissionRefreshError('permission_refresh_timeout'));
  });

  it('normalizes command failures as a typed refresh-unavailable error', async () => {
    const refresh = refreshCapturePermissions({
      client: {
        async sendCommand() {
          throw new Error('/Users/example/private-capture-command');
        },
      },
      eventHandler: {
        getStatus: () => ({}),
        subscribeToPermissionStatus: () => () => undefined,
      },
      now: () => '2026-07-16T00:00:00.500Z',
    });

    await expect(refresh).rejects.toEqual(
      new PermissionRefreshError('permission_refresh_unavailable'),
    );
  });
});
