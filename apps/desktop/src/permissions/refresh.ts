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

export type RequestScreenRecordingPermissionOptions = RefreshCapturePermissionsOptions;

const DEFAULT_PERMISSION_REFRESH_TIMEOUT_MS = 2000;
const DEFAULT_SCREEN_RECORDING_REQUEST_TIMEOUT_MS = 60_000;

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
    super(permissionRefreshErrorMessage(code));
    this.name = 'PermissionRefreshError';
  }
}

export class PermissionRequestError extends Error {
  constructor(public readonly code: PermissionRequestErrorCode) {
    super(permissionRequestErrorMessage(code));
    this.name = 'PermissionRequestError';
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
  return runPermissionCommand({
    ...options,
    commandType: 'permission.refresh',
    defaultTimeoutMs: DEFAULT_PERMISSION_REFRESH_TIMEOUT_MS,
    messageIdPrefix: 'permission-refresh',
    timeoutError: () => new PermissionRefreshError('permission_refresh_timeout'),
    unavailableError: () => new PermissionRefreshError('permission_refresh_unavailable'),
  });
}

/**
 * Deliberately requests macOS Screen Recording access after a renderer user
 * gesture. The native helper still preflights first, so an existing grant
 * returns a fresh status observation without opening a redundant prompt.
 */
export async function requestScreenRecordingPermission(
  options: RequestScreenRecordingPermissionOptions,
): Promise<PermissionSnapshot> {
  return runPermissionCommand({
    ...options,
    commandType: 'permission.request_screen_capture',
    defaultTimeoutMs: DEFAULT_SCREEN_RECORDING_REQUEST_TIMEOUT_MS,
    messageIdPrefix: 'permission-request-screen-recording',
    timeoutError: () => new PermissionRequestError('permission_request_timeout'),
    unavailableError: () => new PermissionRequestError('permission_request_unavailable'),
  });
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

type PermissionCommandOptions = RefreshCapturePermissionsOptions & {
  commandType: 'permission.refresh' | 'permission.request_screen_capture';
  defaultTimeoutMs: number;
  messageIdPrefix: string;
  timeoutError(): Error;
  unavailableError(): Error;
};

async function runPermissionCommand(
  options: PermissionCommandOptions,
): Promise<PermissionSnapshot> {
  const timeoutMs = options.timeoutMs ?? options.defaultTimeoutMs;
  const previousPermissionStatusSequence =
    options.eventHandler.getStatus().permissionStatusSequence;
  let observation: PermissionObservation | undefined;

  try {
    // Subscribe before sending so an immediate helper reply cannot be missed.
    observation = observeNewPermissionStatus(
      options.eventHandler,
      previousPermissionStatusSequence,
    );
    const sentAt = options.now();
    await options.client.sendCommand({
      correlationId: null,
      messageId: `${options.messageIdPrefix}-${sentAt}`,
      payload: {},
      protocolVersion: HELPER_PROTOCOL_VERSION,
      sentAt,
      type: options.commandType,
    });
  } catch {
    observation?.cancel();
    throw options.unavailableError();
  }

  try {
    return await waitForPermissionObservation(observation.promise, timeoutMs, options.timeoutError);
  } finally {
    observation.cancel();
  }
}

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
  timeoutError: () => Error,
): Promise<PermissionSnapshot> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(timeoutError());
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

function permissionRequestErrorMessage(code: PermissionRequestErrorCode): string {
  return code === 'permission_request_timeout'
    ? 'Screen Recording permission request timed out.'
    : 'Screen Recording permission request is unavailable.';
}
