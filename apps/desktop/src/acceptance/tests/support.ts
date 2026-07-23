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
    queue: {
      pending: 3,
      syncing: 1,
      resultPending: 1,
      retrying: 1,
      failed: 2,
      blocked: 0,
    },
    inFlight: [
      {
        localJobId: 'cap-1780000000000-1',
        serverCaptureId: '11111111-1111-4111-8111-111111111111',
        appName: 'Cursor',
        localStage: 'running_ocr',
        attempt: 1,
        ageSeconds: 12,
        safeErrorCode: null,
        createdAt: '2026-07-18T07:59:48.000Z',
        updatedAt: '2026-07-18T08:00:00.000Z',
        nextRetryAt: null,
      },
    ],
    queueHeads: [
      {
        localJobId: 'cap-1780000000000-2',
        serverCaptureId: null,
        appName: 'Safari',
        localStage: 'failed',
        attempt: 3,
        ageSeconds: 90,
        safeErrorCode: 'provider_timeout',
        createdAt: '2026-07-18T07:58:30.000Z',
        updatedAt: '2026-07-18T08:00:00.000Z',
        nextRetryAt: null,
      },
    ],
    ...overrides,
  };
}
