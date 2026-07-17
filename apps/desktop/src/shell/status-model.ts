export type DesktopShellStatus = {
  captureState: string;
  capturePaused: boolean;
  screenRecording: string;
  accessibility: string;
  syncPending: number;
  syncRetrying: number;
  syncFailed: number;
  syncBlocked: number;
  captureFailureCount?: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
};

export function formatTrayTooltip(
  status: DesktopShellStatus,
  activeAlerts: readonly { trayLabel: string }[] = [],
): string {
  if (activeAlerts.length > 0) {
    return `Recapsy · Attention required · ${activeAlerts.map((alert) => alert.trayLabel).join(', ')}`;
  }
  const permissionLabel =
    status.screenRecording === 'granted' ? 'Screen recording granted' : 'Screen recording required';
  const syncLabel =
    status.syncFailed > 0
      ? `${status.syncFailed} sync failed`
      : status.syncPending > 0
        ? `${status.syncPending} sync pending`
        : 'Sync idle';

  return `Recapsy · ${status.capturePaused ? 'Paused' : status.captureState} · ${permissionLabel} · ${syncLabel}`;
}

export function formatPermissionLabel(state: string): string {
  switch (state) {
    case 'granted':
      return 'Granted';
    case 'denied':
      return 'Denied';
    case 'not_determined':
      return 'Not determined';
    default:
      return 'Unknown';
  }
}

export function isCaptureBlockedByPermissions(status: DesktopShellStatus): boolean {
  return status.screenRecording !== 'granted';
}
