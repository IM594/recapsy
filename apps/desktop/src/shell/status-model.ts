export type DesktopShellStatus = {
  captureState: string;
  capturePaused: boolean;
  capturePauseReason?: 'user' | 'backpressure' | 'storage' | 'policy' | 'permission';
  screenRecording: string;
  accessibility: string;
  syncPending: number;
  syncProcessing?: number;
  syncRetrying: number;
  syncFailed: number;
  syncBlocked: number;
  syncInputPerMinute?: number;
  syncCompletedPerMinute?: number;
  syncOldestActiveAgeSeconds?: number;
  syncWorkerCapacity?: {
    activeWorkers: number;
    localMaxWorkers: number;
    serverMaxConcurrentOcr: number;
  };
  captureAdmission?: {
    active: boolean;
    reasons: string[];
  };
  capturePolicy?: {
    hash: string;
    version: string;
  };
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
      : (status.syncProcessing ?? 0) > 0
        ? `${status.syncProcessing} sync processing`
        : status.syncRetrying > 0
          ? `${status.syncRetrying} sync waiting to retry`
          : status.syncPending > 0
            ? `${status.syncPending} sync pending${status.syncOldestActiveAgeSeconds ? `, oldest ${formatAge(status.syncOldestActiveAgeSeconds)}` : ''}`
            : 'Sync idle';

  const captureLabel =
    status.capturePauseReason === 'storage'
      ? 'Storage protection'
      : status.capturePauseReason === 'backpressure'
        ? 'Catching up'
        : status.capturePaused
          ? 'Paused'
          : status.captureState;
  const throughputLabel =
    status.syncInputPerMinute !== undefined || status.syncCompletedPerMinute !== undefined
      ? `in ${status.syncInputPerMinute ?? 0}/min · done ${status.syncCompletedPerMinute ?? 0}/min`
      : undefined;
  const admissionLabel =
    status.captureAdmission?.active && status.captureAdmission.reasons.length > 0
      ? `admission ${status.captureAdmission.reasons.join(',')}`
      : undefined;
  const policyLabel = status.capturePolicy ? `policy ${status.capturePolicy.version}` : undefined;
  return [
    'Recapsy',
    captureLabel,
    permissionLabel,
    syncLabel,
    throughputLabel,
    admissionLabel,
    policyLabel,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ');
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
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
