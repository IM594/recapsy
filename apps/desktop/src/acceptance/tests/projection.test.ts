import { describe, expect, test } from 'bun:test';
import { DevAcceptanceDesktopStatusSchema } from '@recapsy/contracts';
import { projectDesktopAcceptanceStatus } from '../projection';
import { acceptanceSnapshot } from './support';

describe('desktop acceptance projection', () => {
  test('projects the existing shell summary fields and preserves every capture pause reason', () => {
    const projection = projectDesktopAcceptanceStatus({
      runtimeInstanceId: '3ce54e1d-5a17-4cb5-a1bc-6f64e2025dd1',
      workspaceId: 'aa0d899f-64b5-41cb-a16f-65a1ea649db7',
      observedAt: '2026-07-18T08:00:00.000Z',
      snapshot: acceptanceSnapshot({
        capturePauseReasons: ['user', 'backpressure', 'storage', 'policy', 'permission'],
      }),
    });

    expect(DevAcceptanceDesktopStatusSchema.parse(projection)).toEqual(projection);
    expect(projection).toEqual({
      schemaVersion: 1,
      runtimeInstanceId: '3ce54e1d-5a17-4cb5-a1bc-6f64e2025dd1',
      workspaceId: 'aa0d899f-64b5-41cb-a16f-65a1ea649db7',
      observedAt: '2026-07-18T08:00:00.000Z',
      acceptedCaptureInputPerMinute: 7,
      oldestActiveAgeSeconds: 42,
      workerCapacity: {
        activeWorkers: 2,
        localMaxWorkers: 4,
        serverMaxConcurrentOcr: 3,
      },
      capture: {
        state: 'paused',
        paused: true,
        pauseReasons: ['user', 'backpressure', 'storage', 'policy', 'permission'],
      },
      admission: {
        active: true,
        reasons: ['max_asset_bytes_reached'],
      },
    });
  });

  test('uses null when the shared shell summary has no active queue age', () => {
    const projection = projectDesktopAcceptanceStatus({
      runtimeInstanceId: '3ce54e1d-5a17-4cb5-a1bc-6f64e2025dd1',
      workspaceId: 'aa0d899f-64b5-41cb-a16f-65a1ea649db7',
      observedAt: '2026-07-18T08:00:00.000Z',
      snapshot: acceptanceSnapshot({ syncOldestActiveAgeSeconds: undefined }),
    });

    expect(projection.oldestActiveAgeSeconds).toBeNull();
  });

  test('fails closed when an internal snapshot contains an unapproved reason code', () => {
    expect(() =>
      projectDesktopAcceptanceStatus({
        runtimeInstanceId: '3ce54e1d-5a17-4cb5-a1bc-6f64e2025dd1',
        workspaceId: 'aa0d899f-64b5-41cb-a16f-65a1ea649db7',
        observedAt: '2026-07-18T08:00:00.000Z',
        snapshot: acceptanceSnapshot({
          capturePauseReasons: ['private error message' as 'user'],
        }),
      }),
    ).toThrow();
  });
});
