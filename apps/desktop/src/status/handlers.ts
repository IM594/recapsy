import type { CaptureControl } from '../capture/index';
import { type IpcHandlerMap, type RuntimeStatusDto, createRendererSafeSuccess } from '../ipc/index';

export type StatusHandlerOptions = {
  control: CaptureControl;
};

export function createStatusHandlers(options: StatusHandlerOptions): IpcHandlerMap {
  return {
    'settings.getRuntime': async () => createRendererSafeSuccess(buildRuntimeStatusDto(options)),
  };
}

function buildRuntimeStatusDto(options: StatusHandlerOptions): RuntimeStatusDto {
  const snapshot = options.control.getSnapshot();
  const lastHeartbeatAt = snapshot.lastHeartbeatAt;
  const capturePauseReason = snapshot.pauseReasons?.[0];

  return {
    capturePaused: snapshot.status === 'paused',
    ...(capturePauseReason ? { capturePauseReason } : {}),
    helper: {
      status: toHelperRuntimeStatus(snapshot.captureHelper?.state),
      ...(lastHeartbeatAt ? { lastHeartbeatAt } : {}),
    },
    menuBarActive: snapshot.menuBarActive,
    network: 'unknown',
    status: snapshot.status,
  };
}

function toHelperRuntimeStatus(
  state:
    | NonNullable<ReturnType<CaptureControl['getSnapshot']>['captureHelper']>['state']
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
