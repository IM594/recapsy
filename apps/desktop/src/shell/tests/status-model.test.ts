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
        capturePaused: false,
        captureState: 'running',
        screenRecording: 'granted',
        syncBlocked: 0,
        syncFailed: 0,
        syncPending: 2,
        syncRetrying: 0,
      }),
    ).toBe('Recapsy · running · Screen recording granted · 2 sync pending');

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
