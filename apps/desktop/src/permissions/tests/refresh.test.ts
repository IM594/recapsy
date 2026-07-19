import { describe, expect, it } from 'bun:test';
import {
  type CaptureHelperCommandClient,
  HelperPermissionCommandError,
  type HelperPermissionSnapshot,
} from '../../helper/index';
import {
  PermissionRefreshError,
  PermissionRequestError,
  readCapturePermissions,
  refreshCapturePermissions,
  requestScreenRecordingPermission,
} from '../refresh';

const grantedPermissions: HelperPermissionSnapshot = {
  accessibility: 'granted',
  screenRecording: 'granted',
};

describe('capture permission commands', () => {
  it('returns the latest control snapshot without asking the helper', () => {
    expect(
      readCapturePermissions({
        getSnapshot: () => ({ permissions: grantedPermissions }),
      }),
    ).toEqual(grantedPermissions);
    expect(readCapturePermissions({ getSnapshot: () => ({}) })).toEqual({
      accessibility: 'unknown',
      screenRecording: 'unknown',
    });
  });

  it('delegates refresh completion and timeout ownership to the helper client', async () => {
    const timeouts: Array<number | undefined> = [];
    const client = createCommandClient({
      refreshPermissions: async ({ timeoutMs } = {}) => {
        timeouts.push(timeoutMs);
        return grantedPermissions;
      },
    });

    await expect(refreshCapturePermissions({ client, timeoutMs: 1500 })).resolves.toEqual(
      grantedPermissions,
    );
    expect(timeouts).toEqual([1500]);
  });

  it('maps a helper-owned refresh timeout to the IPC-safe refresh error', async () => {
    const client = createCommandClient({
      refreshPermissions: async () => {
        throw new HelperPermissionCommandError('permission_timeout');
      },
    });

    await expect(refreshCapturePermissions({ client })).rejects.toEqual(
      new PermissionRefreshError('permission_refresh_timeout'),
    );
  });

  it('maps helper transport failures to a safe refresh-unavailable error', async () => {
    const client = createCommandClient({
      refreshPermissions: async () => {
        throw new Error('/private/var/folders/secret/permission-command');
      },
    });

    await expect(refreshCapturePermissions({ client })).rejects.toEqual(
      new PermissionRefreshError('permission_refresh_unavailable'),
    );
  });

  it('delegates the explicit screen-recording request by correlated helper command', async () => {
    const timeouts: Array<number | undefined> = [];
    const client = createCommandClient({
      requestScreenRecordingPermission: async ({ timeoutMs } = {}) => {
        timeouts.push(timeoutMs);
        return grantedPermissions;
      },
    });

    await expect(requestScreenRecordingPermission({ client, timeoutMs: 60_000 })).resolves.toEqual(
      grantedPermissions,
    );
    expect(timeouts).toEqual([60_000]);
  });

  it('maps a helper-owned request timeout to the distinct request error', async () => {
    const client = createCommandClient({
      requestScreenRecordingPermission: async () => {
        throw new HelperPermissionCommandError('permission_timeout');
      },
    });

    await expect(requestScreenRecordingPermission({ client })).rejects.toEqual(
      new PermissionRequestError('permission_request_timeout'),
    );
  });
});

function createCommandClient(
  overrides: Partial<
    Pick<CaptureHelperCommandClient, 'refreshPermissions' | 'requestScreenRecordingPermission'>
  >,
): CaptureHelperCommandClient {
  return {
    async sendCommand() {},
    refreshPermissions: async () => grantedPermissions,
    requestScreenRecordingPermission: async () => grantedPermissions,
    ...overrides,
  };
}
