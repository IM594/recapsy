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
      'Recapsy · 运行中 · 屏幕录制已授权 · 处理中 1 · 排队 2 · 最老 42秒 · 接收 7/分 · 完成 5/分 · 准入 max_asset_bytes_reached · 策略 policy-primary · 错误 provider_unavailable',
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
      '追赶中 · 屏幕录制已授权 · 处理中 0 · 排队 9 · 最老 无 · 接收 0/分 · 完成 0/分 · 准入开放 · 策略未应用 · 错误无',
    );

    expect(formatPermissionLabel('not_determined')).toBe('未决定');
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
