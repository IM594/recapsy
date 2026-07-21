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
  syncLastErrorCode?: string;
  syncLastErrorMessage?: string;
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
  /** ISO timestamp of the latest helper heartbeat; absent until the first pulse. */
  lastHeartbeatAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
};

export function formatTrayTooltip(
  status: DesktopShellStatus,
  activeAlerts: readonly { trayLabel: string }[] = [],
): string {
  const permissionLabel =
    status.screenRecording === 'granted' ? 'Screen recording granted' : 'Screen recording required';
  const syncLabels = [
    `processing ${status.syncProcessing ?? 0}`,
    `pending ${status.syncPending}`,
    `oldest ${status.syncOldestActiveAgeSeconds === undefined ? 'none' : formatAge(status.syncOldestActiveAgeSeconds)}`,
  ];

  const captureLabel =
    status.capturePauseReason === 'storage'
      ? 'Storage protection'
      : status.capturePauseReason === 'backpressure'
        ? 'Catching up'
        : status.capturePaused
          ? 'Paused'
          : status.captureState;
  const throughputLabel = `in ${status.syncInputPerMinute ?? 0}/min · done ${status.syncCompletedPerMinute ?? 0}/min`;
  const admissionLabel = status.captureAdmission?.active
    ? `admission ${status.captureAdmission.reasons.length > 0 ? status.captureAdmission.reasons.join(',') : 'closed'}`
    : 'admission open';
  const policyLabel = status.capturePolicy
    ? `policy ${status.capturePolicy.version}`
    : 'policy not applied';
  const errorLabel =
    status.syncLastErrorCode || status.lastErrorCode
      ? `error ${status.syncLastErrorCode ?? status.lastErrorCode}`
      : 'error none';
  const alertLabel =
    activeAlerts.length > 0
      ? `Attention required: ${activeAlerts.map((alert) => alert.trayLabel).join(', ')}`
      : undefined;
  return [
    'Recapsy',
    captureLabel,
    permissionLabel,
    ...syncLabels,
    throughputLabel,
    admissionLabel,
    policyLabel,
    errorLabel,
    alertLabel,
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
