import type { DesktopShellStatus } from './status-model';

export type DesktopHealthAlertKind =
  | 'capture_unavailable'
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
  syncBacklogGraceMs?: number;
  syncBacklogThreshold?: number;
};

export type DesktopHealthMonitor = {
  evaluate(status: DesktopShellStatus, now: number): DesktopHealthSnapshot;
};

const DEFAULT_CAPTURE_FAILURE_THRESHOLD = 3;
const DEFAULT_SYNC_BACKLOG_GRACE_MS = 5 * 60_000;
const DEFAULT_SYNC_BACKLOG_THRESHOLD = 20;

const ALERTS: Readonly<Record<DesktopHealthAlertKind, DesktopHealthAlert>> = {
  capture_unavailable: {
    body: 'Capture stopped unexpectedly. Open Recapsy to restore capture.',
    kind: 'capture_unavailable',
    title: 'Recapsy capture stopped',
    trayLabel: 'Capture stopped',
  },
  screen_recording_required: {
    body: 'Screen Recording permission is required. Open Recapsy to restore capture.',
    kind: 'screen_recording_required',
    title: 'Recapsy needs Screen Recording',
    trayLabel: 'Screen Recording required',
  },
  capture_failures: {
    body: 'Recent captures repeatedly failed. Open Recapsy to check capture status.',
    kind: 'capture_failures',
    title: 'Recapsy capture is failing',
    trayLabel: 'Capture repeatedly failing',
  },
  sync_blocked: {
    body: 'Some captures are blocked from syncing. Open Recapsy to review the queue.',
    kind: 'sync_blocked',
    title: 'Recapsy sync is blocked',
    trayLabel: 'Sync blocked',
  },
  sync_failed: {
    body: 'Some captures could not sync. Open Recapsy to review the queue.',
    kind: 'sync_failed',
    title: 'Recapsy sync failed',
    trayLabel: 'Sync failed',
  },
  sync_backlog: {
    body: 'Capture sync has been backlogged for several minutes. Open Recapsy to review the queue.',
    kind: 'sync_backlog',
    title: 'Recapsy sync is delayed',
    trayLabel: 'Sync backlog',
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

  return {
    evaluate(status, now) {
      const activeKinds = activeAlertKinds(status, {
        captureFailureThreshold,
        syncBacklogGraceMs,
        syncBacklogThreshold,
        backlogStartedAt,
        now,
      });
      const hasBacklog = activeKinds.includes('sync_backlog');
      const pendingBacklog = status.syncPending >= syncBacklogThreshold;

      if (pendingBacklog && backlogStartedAt === undefined) {
        backlogStartedAt = now;
      } else if (!pendingBacklog) {
        backlogStartedAt = undefined;
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
    syncBacklogGraceMs: number;
    syncBacklogThreshold: number;
    backlogStartedAt: number | undefined;
    now: number;
  },
): DesktopHealthAlertKind[] {
  const active: DesktopHealthAlertKind[] = [];
  if (status.lastErrorCode && CAPTURE_UNAVAILABLE_CODES.has(status.lastErrorCode)) {
    active.push('capture_unavailable');
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

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}
