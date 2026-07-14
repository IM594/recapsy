import type { CaptureLifecycle } from '../capture/public';
import {
  type IpcHandlerMap,
  type RuntimeStatusDto,
  createRendererSafeSuccess,
} from '../ipc/public';

export type RuntimeStatusSource = {
  getLastObservedAt(): string | undefined;
};

export type RuntimeIpcHandlerOptions = {
  lifecycle: CaptureLifecycle;
  statusSource: RuntimeStatusSource;
};

export function createRuntimeIpcHandlers(options: RuntimeIpcHandlerOptions): IpcHandlerMap {
  return {
    'settings.getRuntime': async () => createRendererSafeSuccess(buildRuntimeStatusDto(options)),
  };
}

function buildRuntimeStatusDto(options: RuntimeIpcHandlerOptions): RuntimeStatusDto {
  const snapshot = options.lifecycle.getSnapshot();
  const lastObservedAt = options.statusSource.getLastObservedAt();

  return {
    capturePaused: snapshot.status === 'paused',
    helper: {
      status: toHelperRuntimeStatus(snapshot.captureHelper?.state),
      ...(lastObservedAt ? { lastHeartbeatAt: lastObservedAt } : {}),
    },
    menuBarActive: snapshot.menuBarActive,
    network: 'unknown',
    status: snapshot.status,
  };
}

function toHelperRuntimeStatus(
  state:
    | NonNullable<ReturnType<CaptureLifecycle['getSnapshot']>['captureHelper']>['state']
    | undefined,
): RuntimeStatusDto['helper']['status'] {
  switch (state) {
    case undefined:
    case 'idle':
      return 'not_started';
    case 'starting':
      return 'starting';
    case 'running':
    case 'paused':
      return 'ready';
    case 'stopping':
    case 'stopped':
      return 'stopped';
    case 'failed':
    case 'exited':
      return 'degraded';
  }
}
