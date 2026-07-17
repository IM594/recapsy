import { describe, expect, it } from 'bun:test';
import { createDesktopHealthMonitor } from '../health-monitor';
import type { DesktopShellStatus } from '../status-model';

const healthyStatus: DesktopShellStatus = {
  accessibility: 'granted',
  captureFailureCount: 0,
  capturePaused: false,
  captureState: 'running',
  screenRecording: 'granted',
  syncBlocked: 0,
  syncFailed: 0,
  syncPending: 0,
  syncRetrying: 0,
};

describe('desktop health monitor', () => {
  it('alerts once when the capture process unexpectedly exits, then alerts again only after recovery', () => {
    const monitor = createDesktopHealthMonitor();
    const stopped = { ...healthyStatus, lastErrorCode: 'helper_unexpected_exit' };

    expect(monitor.evaluate(stopped, 0).newAlerts.map((alert) => alert.kind)).toEqual([
      'capture_unavailable',
    ]);
    expect(monitor.evaluate(stopped, 1).newAlerts).toEqual([]);
    expect(monitor.evaluate(healthyStatus, 2).activeAlerts).toEqual([]);
    expect(monitor.evaluate(stopped, 3).newAlerts.map((alert) => alert.kind)).toEqual([
      'capture_unavailable',
    ]);
  });

  it('alerts immediately when Screen Recording becomes denied and clears the warning after it is restored', () => {
    const monitor = createDesktopHealthMonitor();

    expect(
      monitor
        .evaluate({ ...healthyStatus, screenRecording: 'denied' }, 0)
        .newAlerts.map((alert) => alert.kind),
    ).toEqual(['screen_recording_required']);
    expect(monitor.evaluate(healthyStatus, 1).activeAlerts).toEqual([]);
  });

  it('treats a native permission revocation as an immediate Screen Recording alert before status refresh', () => {
    const monitor = createDesktopHealthMonitor();

    expect(
      monitor
        .evaluate({ ...healthyStatus, lastErrorCode: 'permission_revoked' }, 0)
        .newAlerts.map((alert) => alert.kind),
    ).toEqual(['screen_recording_required']);
  });

  it('waits for repeated native capture failures before notifying, and resets after a successful capture', () => {
    const monitor = createDesktopHealthMonitor({ consecutiveCaptureFailureThreshold: 3 });

    expect(
      monitor.evaluate(
        { ...healthyStatus, captureFailureCount: 2, lastErrorCode: 'capture_failed' },
        0,
      ).newAlerts,
    ).toEqual([]);
    expect(
      monitor
        .evaluate({ ...healthyStatus, captureFailureCount: 3, lastErrorCode: 'capture_failed' }, 1)
        .newAlerts.map((alert) => alert.kind),
    ).toEqual(['capture_failures']);
    expect(monitor.evaluate(healthyStatus, 2).activeAlerts).toEqual([]);
  });

  it('only alerts for a large pending sync queue after the configured grace period', () => {
    const monitor = createDesktopHealthMonitor({
      syncBacklogGraceMs: 60,
      syncBacklogThreshold: 20,
    });
    const backlogged = { ...healthyStatus, syncPending: 20 };

    expect(monitor.evaluate(backlogged, 100).newAlerts).toEqual([]);
    expect(monitor.evaluate(backlogged, 159).newAlerts).toEqual([]);
    expect(monitor.evaluate(backlogged, 160).newAlerts.map((alert) => alert.kind)).toEqual([
      'sync_backlog',
    ]);
    expect(monitor.evaluate(backlogged, 161).newAlerts).toEqual([]);
  });

  it('alerts immediately for terminal sync failures without treating a retrying job as terminal', () => {
    const monitor = createDesktopHealthMonitor();

    expect(monitor.evaluate({ ...healthyStatus, syncRetrying: 3 }, 0).newAlerts).toEqual([]);
    expect(
      monitor.evaluate({ ...healthyStatus, syncFailed: 1 }, 1).newAlerts.map((alert) => alert.kind),
    ).toEqual(['sync_failed']);
    expect(
      monitor
        .evaluate({ ...healthyStatus, syncBlocked: 1 }, 2)
        .newAlerts.map((alert) => alert.kind),
    ).toEqual(['sync_blocked']);
  });
});
