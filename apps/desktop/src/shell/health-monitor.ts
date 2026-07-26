import productIdentity from '../product-identity.json';
import type { DesktopShellStatus } from './status-model';

export type DesktopHealthAlertKind =
  | 'capture_unavailable'
  | 'capture_stalled'
  | 'screen_recording_required'
  | 'capture_failures'
  | 'sync_blocked'
  | 'sync_failed'
  | 'sync_backlog';

export type DesktopHealthAlert = {
  kind: DesktopHealthAlertKind;
  title: string;
  body: string;
  trayLabel: string;
};

export type DesktopHealthSnapshot = {
  activeAlerts: readonly DesktopHealthAlert[];
  newAlerts: readonly DesktopHealthAlert[];
};

export type DesktopHealthMonitorOptions = {
  consecutiveCaptureFailureThreshold?: number;
  /**
   * How old a helper heartbeat may be while capture is `running` before the
   * stall condition becomes pending. Tuned as a small multiple of the native
   * helper heartbeat cadence (~1s).
   */
  heartbeatStaleThresholdMs?: number;
  /**
   * How long the stall condition must remain continuously true before the
   * alert fires. Absorbs sleep/wake gaps and brief helper hiccups.
   */
  heartbeatStaleGraceMs?: number;
  syncBacklogGraceMs?: number;
  syncBacklogThreshold?: number;
};

export type DesktopHealthMonitor = {
  evaluate(status: DesktopShellStatus, now: number): DesktopHealthSnapshot;
};

const DEFAULT_CAPTURE_FAILURE_THRESHOLD = 3;
/** ~15× the native 1s heartbeat — clearly dead, not a single missed pulse. */
const DEFAULT_HEARTBEAT_STALE_THRESHOLD_MS = 15_000;
/** Require the stall to persist across sleep/wake blips before notifying. */
const DEFAULT_HEARTBEAT_STALE_GRACE_MS = 15_000;
const DEFAULT_SYNC_BACKLOG_GRACE_MS = 5 * 60_000;
const DEFAULT_SYNC_BACKLOG_THRESHOLD = 20;

const ALERTS: Readonly<Record<DesktopHealthAlertKind, DesktopHealthAlert>> = {
  capture_unavailable: {
    body: `采集意外停止。请打开 ${productIdentity.displayName} 恢复采集。`,
    kind: 'capture_unavailable',
    title: `${productIdentity.displayName} 采集已停止`,
    trayLabel: '采集已停止',
  },
  capture_stalled: {
    body: `采集似乎已静默停止。请打开 ${productIdentity.displayName} 恢复采集。`,
    kind: 'capture_stalled',
    title: `${productIdentity.displayName} 采集已卡住`,
    trayLabel: '采集已卡住',
  },
  screen_recording_required: {
    body: `需要屏幕录制权限。请打开 ${productIdentity.displayName} 恢复采集。`,
    kind: 'screen_recording_required',
    title: `${productIdentity.displayName} 需要屏幕录制权限`,
    trayLabel: '需要屏幕录制权限',
  },
  capture_failures: {
    body: `近期采集反复失败。请打开 ${productIdentity.displayName} 检查采集状态。`,
    kind: 'capture_failures',
    title: `${productIdentity.displayName} 采集失败`,
    trayLabel: '采集反复失败',
  },
  sync_blocked: {
    body: `部分采集无法同步。请打开 ${productIdentity.displayName} 查看队列。`,
    kind: 'sync_blocked',
    title: `${productIdentity.displayName} 同步已阻塞`,
    trayLabel: '同步已阻塞',
  },
  sync_failed: {
    body: `部分采集同步失败。请打开 ${productIdentity.displayName} 查看队列。`,
    kind: 'sync_failed',
    title: `${productIdentity.displayName} 同步失败`,
    trayLabel: '同步失败',
  },
  sync_backlog: {
    body: `采集同步已积压数分钟。请打开 ${productIdentity.displayName} 查看队列。`,
    kind: 'sync_backlog',
    title: `${productIdentity.displayName} 同步延迟`,
    trayLabel: '同步积压',
  },
};

const CAPTURE_UNAVAILABLE_CODES = new Set([
  'helper_start_failed',
  'helper_unavailable',
  'helper_unexpected_exit',
]);

const SCREEN_RECORDING_ERROR_CODES = new Set(['permission_missing', 'permission_revoked']);

/**
 * Converts safe, local operational facts into user-actionable health alerts.
 * Alerts are edge-triggered: one notification is emitted while an issue stays
 * active, and another can occur only after the condition has recovered.
 */
export function createDesktopHealthMonitor(
  options: DesktopHealthMonitorOptions = {},
): DesktopHealthMonitor {
  const captureFailureThreshold = positiveInteger(
    options.consecutiveCaptureFailureThreshold,
    DEFAULT_CAPTURE_FAILURE_THRESHOLD,
  );
  const heartbeatStaleThresholdMs = positiveInteger(
    options.heartbeatStaleThresholdMs,
    DEFAULT_HEARTBEAT_STALE_THRESHOLD_MS,
  );
  const heartbeatStaleGraceMs = positiveInteger(
    options.heartbeatStaleGraceMs,
    DEFAULT_HEARTBEAT_STALE_GRACE_MS,
  );
  const syncBacklogGraceMs = positiveInteger(
    options.syncBacklogGraceMs,
    DEFAULT_SYNC_BACKLOG_GRACE_MS,
  );
  const syncBacklogThreshold = positiveInteger(
    options.syncBacklogThreshold,
    DEFAULT_SYNC_BACKLOG_THRESHOLD,
  );
  let previousActive = new Set<DesktopHealthAlertKind>();
  let backlogStartedAt: number | undefined;
  let stallStartedAt: number | undefined;

  return {
    evaluate(status, now) {
      const activeKinds = activeAlertKinds(status, {
        captureFailureThreshold,
        heartbeatStaleGraceMs,
        heartbeatStaleThresholdMs,
        syncBacklogGraceMs,
        syncBacklogThreshold,
        backlogStartedAt,
        stallStartedAt,
        now,
      });
      const hasBacklog = activeKinds.includes('sync_backlog');
      const hasStalled = activeKinds.includes('capture_stalled');
      const pendingBacklog = status.syncPending >= syncBacklogThreshold;
      const pendingStall = isHeartbeatStalePending(status, now, heartbeatStaleThresholdMs);

      if (pendingBacklog && backlogStartedAt === undefined) {
        backlogStartedAt = now;
      } else if (!pendingBacklog) {
        backlogStartedAt = undefined;
      }

      if (pendingStall && stallStartedAt === undefined) {
        stallStartedAt = now;
      } else if (!pendingStall) {
        stallStartedAt = undefined;
      }

      // `activeAlertKinds` reads the start timestamp from the previous sample,
      // deliberately making the grace boundary observable on the next refresh.
      // This prevents a single long status read from manufacturing elapsed time.
      if (
        !hasBacklog &&
        pendingBacklog &&
        backlogStartedAt !== undefined &&
        now - backlogStartedAt >= syncBacklogGraceMs
      ) {
        activeKinds.push('sync_backlog');
      }
      if (
        !hasStalled &&
        pendingStall &&
        stallStartedAt !== undefined &&
        now - stallStartedAt >= heartbeatStaleGraceMs
      ) {
        activeKinds.push('capture_stalled');
      }

      const nextActive = new Set(activeKinds);
      const activeAlerts = activeKinds.map((kind) => ALERTS[kind]);
      const newAlerts = activeKinds
        .filter((kind) => !previousActive.has(kind))
        .map((kind) => ALERTS[kind]);
      previousActive = nextActive;
      return { activeAlerts, newAlerts };
    },
  };
}

function activeAlertKinds(
  status: DesktopShellStatus,
  options: {
    captureFailureThreshold: number;
    heartbeatStaleGraceMs: number;
    heartbeatStaleThresholdMs: number;
    syncBacklogGraceMs: number;
    syncBacklogThreshold: number;
    backlogStartedAt: number | undefined;
    stallStartedAt: number | undefined;
    now: number;
  },
): DesktopHealthAlertKind[] {
  const active: DesktopHealthAlertKind[] = [];
  if (status.lastErrorCode && CAPTURE_UNAVAILABLE_CODES.has(status.lastErrorCode)) {
    active.push('capture_unavailable');
  }
  if (
    options.stallStartedAt !== undefined &&
    options.now - options.stallStartedAt >= options.heartbeatStaleGraceMs &&
    isHeartbeatStalePending(status, options.now, options.heartbeatStaleThresholdMs)
  ) {
    active.push('capture_stalled');
  }
  if (
    status.screenRecording === 'denied' ||
    (status.lastErrorCode !== undefined && SCREEN_RECORDING_ERROR_CODES.has(status.lastErrorCode))
  ) {
    active.push('screen_recording_required');
  }
  if (
    status.lastErrorCode === 'capture_failed' &&
    (status.captureFailureCount ?? 0) >= options.captureFailureThreshold
  ) {
    active.push('capture_failures');
  }
  if (status.syncBlocked > 0) {
    active.push('sync_blocked');
  }
  if (status.syncFailed > 0) {
    active.push('sync_failed');
  }
  if (
    status.syncPending >= options.syncBacklogThreshold &&
    options.backlogStartedAt !== undefined &&
    options.now - options.backlogStartedAt >= options.syncBacklogGraceMs
  ) {
    active.push('sync_backlog');
  }
  return active;
}

/**
 * Local counterpart of server `isCaptureStale`: intended-to-run capture with no
 * fresh helper heartbeat. Paused/stopped/starting are explained absences.
 * A missing `lastHeartbeatAt` while running counts as stale (never pulsed).
 */
function isHeartbeatStalePending(
  status: DesktopShellStatus,
  now: number,
  thresholdMs: number,
): boolean {
  if (status.captureState !== 'running' || status.capturePaused) {
    return false;
  }
  if (!status.lastHeartbeatAt) {
    return true;
  }
  const heartbeatAt = Date.parse(status.lastHeartbeatAt);
  if (!Number.isFinite(heartbeatAt)) {
    return true;
  }
  return now - heartbeatAt > thresholdMs;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}
