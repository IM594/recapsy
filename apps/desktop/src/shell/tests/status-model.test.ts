import { describe, expect, it } from 'bun:test';
import {
  formatPermissionLabel,
  formatTrayTooltip,
  isCaptureBlockedByPermissions,
} from '../status-model';

describe('desktop shell status model', () => {
  it('formats tray tooltip and permission labels', () => {
    expect(
      formatTrayTooltip({
        accessibility: 'not_determined',
        captureAdmission: { active: true, reasons: ['max_asset_bytes_reached'] },
        capturePaused: false,
        capturePolicy: { hash: 'sha256:private', version: 'policy-primary' },
        captureState: 'running',
        screenRecording: 'granted',
        syncBlocked: 0,
        syncCompletedPerMinute: 5,
        syncFailed: 0,
        syncInputPerMinute: 7,
        syncOldestActiveAgeSeconds: 42,
        syncPending: 2,
        syncProcessing: 1,
        syncRetrying: 0,
        syncLastErrorCode: 'provider_unavailable',
      }),
    ).toBe(
      'Recapsy · running · Screen recording granted · processing 1 · pending 2 · oldest 42s · in 7/min · done 5/min · admission max_asset_bytes_reached · policy policy-primary · error provider_unavailable',
    );

    expect(
      formatTrayTooltip({
        accessibility: 'granted',
        capturePaused: true,
        capturePauseReason: 'backpressure',
        captureState: 'paused',
        screenRecording: 'granted',
        syncBlocked: 0,
        syncFailed: 0,
        syncPending: 9,
        syncRetrying: 0,
      }),
    ).toContain(
      'Catching up · Screen recording granted · processing 0 · pending 9 · oldest none · in 0/min · done 0/min · admission open · policy not applied · error none',
    );

    expect(formatPermissionLabel('not_determined')).toBe('Not determined');
    expect(
      isCaptureBlockedByPermissions({
        accessibility: 'granted',
        capturePaused: false,
        captureState: 'running',
        screenRecording: 'not_determined',
        syncBlocked: 0,
        syncFailed: 0,
        syncPending: 0,
        syncRetrying: 0,
      }),
    ).toBe(true);
  });
});
