import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBunSqliteDatabase } from '../bun';
import { SqliteCoveragePersistence } from '../coverage';
import { migrateSqliteStore } from '../migrations';

const workspaceId = 'workspace_1';
const deviceId = 'device_1';
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe('SQLite coverage persistence', () => {
  it('opens, extends, and closes a run-length segment as one growing row', async () => {
    const coverage = createTempCoverage();

    await coverage.openCoverageSegment({
      coverageState: 'static',
      deviceId,
      intervalMs: 3000,
      now: '2026-07-20T08:00:00.000Z',
      startedAt: '2026-07-20T08:00:00.000Z',
      workspaceId,
    });
    await coverage.extendOpenCoverageSegment({
      deviceId,
      now: '2026-07-20T08:00:03.000Z',
      tickCount: 2,
      workspaceId,
    });
    await coverage.extendOpenCoverageSegment({
      deviceId,
      now: '2026-07-20T08:00:06.000Z',
      tickCount: 3,
      workspaceId,
    });

    expect(await coverage.getOpenCoverageSegment(workspaceId, deviceId)).toEqual({
      coverageState: 'static',
      intervalMs: 3000,
      startedAt: '2026-07-20T08:00:00.000Z',
      tickCount: 3,
    });

    const closed = await coverage.closeOpenCoverageSegment({
      closeReason: 'state_changed',
      deviceId,
      endedAt: '2026-07-20T08:00:06.000Z',
      now: '2026-07-20T08:00:07.000Z',
      workspaceId,
    });

    expect(closed).toMatchObject({
      closeReason: 'state_changed',
      coverageState: 'static',
      deviceId,
      endedAt: '2026-07-20T08:00:06.000Z',
      intervalMs: 3000,
      startedAt: '2026-07-20T08:00:00.000Z',
      syncState: 'pending',
      tickCount: 3,
      workspaceId,
    });
    expect(await coverage.getOpenCoverageSegment(workspaceId, deviceId)).toBeNull();
  });

  it('returns null closing when nothing is open', async () => {
    const coverage = createTempCoverage();

    const closed = await coverage.closeOpenCoverageSegment({
      closeReason: 'helper_exit',
      deviceId,
      endedAt: '2026-07-20T08:00:00.000Z',
      now: '2026-07-20T08:00:00.000Z',
      workspaceId,
    });

    expect(closed).toBeNull();
  });

  it('lists only pending segments and marks them synced', async () => {
    const coverage = createTempCoverage();
    await openAndCloseSegment(coverage, '2026-07-20T08:00:00.000Z', '2026-07-20T08:00:03.000Z');
    await openAndCloseSegment(coverage, '2026-07-20T08:00:10.000Z', '2026-07-20T08:00:13.000Z');

    const pending = await coverage.listPendingCoverageSegments(workspaceId);
    expect(pending).toHaveLength(2);
    expect(pending.every((segment) => segment.syncState === 'pending')).toBe(true);

    await coverage.markCoverageSegmentsSynced(pending.slice(0, 1).map((segment) => segment.id));

    const remaining = await coverage.listPendingCoverageSegments(workspaceId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(pending[1]?.id);
  });

  it('upserts device liveness without disturbing an open coverage run', async () => {
    const coverage = createTempCoverage();
    await coverage.openCoverageSegment({
      coverageState: 'blank',
      deviceId,
      intervalMs: 3000,
      now: '2026-07-20T08:00:00.000Z',
      startedAt: '2026-07-20T08:00:00.000Z',
      workspaceId,
    });

    await coverage.upsertDeviceCaptureLiveness({
      deviceId,
      desiredState: 'running',
      lastAliveAt: '2026-07-20T08:00:05.000Z',
      now: '2026-07-20T08:00:05.000Z',
      workspaceId,
    });

    expect(await coverage.getDeviceCaptureLiveness(workspaceId, deviceId)).toEqual({
      deviceId,
      desiredState: 'running',
      lastAliveAt: '2026-07-20T08:00:05.000Z',
      updatedAt: '2026-07-20T08:00:05.000Z',
      workspaceId,
    });
    expect(await coverage.getOpenCoverageSegment(workspaceId, deviceId)).toMatchObject({
      coverageState: 'blank',
    });
  });

  it('recovers a hanging open segment at startup using the last-alive timestamp', async () => {
    const coverage = createTempCoverage();
    await coverage.openCoverageSegment({
      coverageState: 'no_window',
      deviceId,
      intervalMs: 3000,
      now: '2026-07-20T08:00:00.000Z',
      startedAt: '2026-07-20T08:00:00.000Z',
      workspaceId,
    });
    await coverage.extendOpenCoverageSegment({
      deviceId,
      now: '2026-07-20T08:00:03.000Z',
      tickCount: 2,
      workspaceId,
    });
    await coverage.upsertDeviceCaptureLiveness({
      deviceId,
      desiredState: 'running',
      lastAliveAt: '2026-07-20T08:00:03.500Z',
      now: '2026-07-20T08:00:03.500Z',
      workspaceId,
    });

    await coverage.recoverHangingCoverageSegment({
      deviceId,
      now: '2026-07-20T08:05:00.000Z',
      workspaceId,
    });

    const pending = await coverage.listPendingCoverageSegments(workspaceId);
    const recovered = pending[0];
    if (!recovered) {
      throw new Error('expected a recovered coverage segment');
    }
    expect(pending).toEqual([
      {
        closeReason: 'inferred_on_recovery',
        coverageState: 'no_window',
        createdAt: '2026-07-20T08:05:00.000Z',
        deviceId,
        endedAt: '2026-07-20T08:00:03.500Z',
        id: recovered.id,
        intervalMs: 3000,
        startedAt: '2026-07-20T08:00:00.000Z',
        syncState: 'pending',
        tickCount: 2,
        workspaceId,
      },
    ]);
    expect(await coverage.getOpenCoverageSegment(workspaceId, deviceId)).toBeNull();
  });

  it('is a no-op recovering when there is no hanging open segment', async () => {
    const coverage = createTempCoverage();
    await coverage.upsertDeviceCaptureLiveness({
      deviceId,
      desiredState: 'stopped',
      lastAliveAt: '2026-07-20T08:00:00.000Z',
      now: '2026-07-20T08:00:00.000Z',
      workspaceId,
    });

    await coverage.recoverHangingCoverageSegment({
      deviceId,
      now: '2026-07-20T08:05:00.000Z',
      workspaceId,
    });

    expect(await coverage.listPendingCoverageSegments(workspaceId)).toEqual([]);
  });
});

async function openAndCloseSegment(
  coverage: SqliteCoveragePersistence,
  startedAt: string,
  endedAt: string,
): Promise<void> {
  await coverage.openCoverageSegment({
    coverageState: 'static',
    deviceId,
    intervalMs: 3000,
    now: startedAt,
    startedAt,
    workspaceId,
  });
  await coverage.closeOpenCoverageSegment({
    closeReason: 'frame_captured',
    deviceId,
    endedAt,
    now: endedAt,
    workspaceId,
  });
}

function createTempCoverage(): SqliteCoveragePersistence {
  const database = createBunSqliteDatabase(tempDatabasePath());
  migrateSqliteStore(database);
  return new SqliteCoveragePersistence(database);
}

function tempDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'recapsy-sqlite-coverage-'));
  tempDirs.push(dir);
  return join(dir, 'operational.sqlite');
}
