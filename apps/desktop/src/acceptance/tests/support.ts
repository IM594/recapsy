import type { DesktopAcceptanceSnapshot } from '../projection';

export function acceptanceSnapshot(
  overrides: Partial<DesktopAcceptanceSnapshot> = {},
): DesktopAcceptanceSnapshot {
  return {
    captureState: 'paused',
    capturePaused: true,
    capturePauseReasons: ['user', 'storage'],
    captureAdmission: {
      active: true,
      reasons: ['max_asset_bytes_reached'],
    },
    syncInputPerMinute: 7,
    syncOldestActiveAgeSeconds: 42,
    syncWorkerCapacity: {
      activeWorkers: 2,
      localMaxWorkers: 4,
      serverMaxConcurrentOcr: 3,
    },
    ...overrides,
  };
}
