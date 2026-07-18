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
    syncCompletedPerMinute: 5,
    syncProcessing: 2,
    syncPending: 3,
    syncOldestActiveAgeSeconds: 42,
    capturePolicyVersion: 'policy-primary',
    safeErrorCode: 'provider_unavailable',
    syncWorkerCapacity: {
      activeWorkers: 2,
      localMaxWorkers: 4,
      serverMaxConcurrentOcr: 3,
    },
    ...overrides,
  };
}
