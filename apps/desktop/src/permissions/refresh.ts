import { type CaptureHelperCommandClient, HELPER_PROTOCOL_VERSION } from '../helper/index';

export type PermissionSnapshot = {
  screenRecording: 'granted' | 'denied' | 'not_determined' | 'unknown';
  accessibility: 'granted' | 'denied' | 'not_determined' | 'unknown';
};

export type PermissionStatusSource = {
  getStatus(): {
    lastObservedAt?: string;
    permissions?: PermissionSnapshot;
    permissionStatusSequence?: number;
  };
  subscribeToPermissionStatus(
    listener: (status: {
      lastObservedAt?: string;
      permissions?: PermissionSnapshot;
      permissionStatusSequence?: number;
    }) => void,
  ): () => void;
};

export type RefreshCapturePermissionsOptions = {
  client: CaptureHelperCommandClient;
  eventHandler: PermissionStatusSource;
  now(): string;
  timeoutMs?: number;
};

const DEFAULT_REFRESH_TIMEOUT_MS = 2000;

export const PERMISSION_REFRESH_ERROR_CODES = [
  'permission_refresh_timeout',
  'permission_refresh_unavailable',
] as const;

export type PermissionRefreshErrorCode = (typeof PERMISSION_REFRESH_ERROR_CODES)[number];

export class PermissionRefreshError extends Error {
  constructor(public readonly code: PermissionRefreshErrorCode) {
    super(permissionRefreshErrorMessage(code));
    this.name = 'PermissionRefreshError';
  }
}

/**
 * Asks the native capture process to re-probe permissions and waits until a
 * newer permission.status observation lands. Cached permissions are only
 * exposed through readCapturePermissions, never as a refresh result.
 */
export async function refreshCapturePermissions(
  options: RefreshCapturePermissionsOptions,
): Promise<PermissionSnapshot> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
  const previousPermissionStatusSequence =
    options.eventHandler.getStatus().permissionStatusSequence;
  let observation: PermissionObservation | undefined;

  try {
    // Subscribe before sending so an immediate response cannot be missed.
    observation = observeNewPermissionStatus(
      options.eventHandler,
      previousPermissionStatusSequence,
    );
    await options.client.sendCommand({
      correlationId: null,
      messageId: `permission-refresh-${options.now()}`,
      payload: {},
      protocolVersion: HELPER_PROTOCOL_VERSION,
      sentAt: options.now(),
      type: 'permission.refresh',
    });
  } catch {
    observation?.cancel();
    throw new PermissionRefreshError('permission_refresh_unavailable');
  }

  try {
    return await waitForPermissionObservation(observation.promise, timeoutMs);
  } finally {
    observation.cancel();
  }
}

export function readCapturePermissions(eventHandler: PermissionStatusSource): PermissionSnapshot {
  return currentOrUnknown(eventHandler);
}

function currentOrUnknown(eventHandler: PermissionStatusSource): PermissionSnapshot {
  return (
    eventHandler.getStatus().permissions ?? {
      accessibility: 'unknown',
      screenRecording: 'unknown',
    }
  );
}

type PermissionObservation = {
  promise: Promise<PermissionSnapshot>;
  cancel(): void;
};

function observeNewPermissionStatus(
  eventHandler: PermissionStatusSource,
  previousPermissionStatusSequence: number | undefined,
): PermissionObservation {
  let settled = false;
  let resolve: (permissions: PermissionSnapshot) => void = () => undefined;
  const promise = new Promise<PermissionSnapshot>((next) => {
    resolve = next;
  });

  const observe = (status: ReturnType<PermissionStatusSource['getStatus']>) => {
    if (
      !settled &&
      status.permissions &&
      status.permissionStatusSequence !== undefined &&
      status.permissionStatusSequence !== previousPermissionStatusSequence
    ) {
      settled = true;
      resolve({ ...status.permissions });
    }
  };
  const unsubscribe = eventHandler.subscribeToPermissionStatus(observe);

  // Bridge the small gap between reading the initial sequence and installing
  // the subscription without treating an unchanged cache as a refresh result.
  observe(eventHandler.getStatus());

  return {
    cancel: unsubscribe,
    promise,
  };
}

function waitForPermissionObservation(
  observation: Promise<PermissionSnapshot>,
  timeoutMs: number,
): Promise<PermissionSnapshot> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new PermissionRefreshError('permission_refresh_timeout'));
    }, timeoutMs);

    observation.then(
      (permissions) => {
        clearTimeout(timeout);
        resolve(permissions);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function permissionRefreshErrorMessage(code: PermissionRefreshErrorCode): string {
  return code === 'permission_refresh_timeout'
    ? 'Permission refresh timed out.'
    : 'Permission refresh is unavailable.';
}
