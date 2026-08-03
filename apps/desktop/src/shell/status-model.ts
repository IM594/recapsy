import productIdentity from '../product-identity.json';
import type { SyncGateStatus } from '../sync/index';

export type DesktopShellPrivacyRule = {
  kind: 'bundle_id' | 'domain' | 'domain_family';
  pattern: string;
  enabled: boolean;
};

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
  syncGate: SyncGateStatus;
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
  privacyRules?: readonly DesktopShellPrivacyRule[];
  /** ISO timestamp of the latest helper heartbeat; absent until the first pulse. */
  lastHeartbeatAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  source?: {
    applicationName: string;
    bundleId: string;
    domain?: string;
    observedAt: string;
  };
};

export function formatTrayTooltip(
  status: DesktopShellStatus,
  activeAlerts: readonly { trayLabel: string }[] = [],
): string {
  const permissionLabel =
    status.screenRecording === 'granted' ? '屏幕录制已授权' : '需要屏幕录制权限';
  const syncLabels = [
    `处理中 ${status.syncProcessing ?? 0}`,
    `排队 ${status.syncPending}`,
    `最老 ${status.syncOldestActiveAgeSeconds === undefined ? '无' : formatAge(status.syncOldestActiveAgeSeconds)}`,
  ];

  const captureLabel =
    status.capturePauseReason === 'storage'
      ? '存储保护'
      : status.capturePauseReason === 'backpressure'
        ? '追赶中'
        : status.capturePaused
          ? '已暂停'
          : formatCaptureStateLabel(status.captureState);
  const throughputLabel = `接收 ${status.syncInputPerMinute ?? 0}/分 · 完成 ${status.syncCompletedPerMinute ?? 0}/分`;
  const admissionLabel = status.captureAdmission?.active
    ? `准入 ${status.captureAdmission.reasons.length > 0 ? status.captureAdmission.reasons.join(',') : '关闭'}`
    : '准入开放';
  const policyLabel = status.capturePolicy ? `策略 ${status.capturePolicy.version}` : '策略未应用';
  const errorLabel =
    status.syncLastErrorCode || status.lastErrorCode
      ? `错误 ${status.syncLastErrorCode ?? status.lastErrorCode}`
      : '错误无';
  const syncGateLabel = status.syncGate.state === 'open' ? undefined : '同步已暂停';
  const alertLabel =
    activeAlerts.length > 0
      ? `需要注意：${activeAlerts.map((alert) => alert.trayLabel).join('、')}`
      : undefined;
  return [
    productIdentity.displayName,
    captureLabel,
    permissionLabel,
    ...syncLabels,
    throughputLabel,
    admissionLabel,
    policyLabel,
    errorLabel,
    syncGateLabel,
    alertLabel,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ');
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分`;
  return `${Math.floor(seconds / 3600)}时`;
}

export function formatCaptureStateLabel(state: string): string {
  switch (state) {
    case 'starting':
      return '启动中';
    case 'running':
      return '运行中';
    case 'paused':
      return '已暂停';
    case 'stopping':
      return '停止中';
    case 'stopped':
      return '已停止';
    default:
      return state;
  }
}

export function formatPermissionLabel(state: string): string {
  switch (state) {
    case 'granted':
      return '已授权';
    case 'denied':
      return '已拒绝';
    case 'not_determined':
      return '未决定';
    default:
      return '未知';
  }
}

export function isCaptureBlockedByPermissions(status: DesktopShellStatus): boolean {
  return status.screenRecording !== 'granted';
}
