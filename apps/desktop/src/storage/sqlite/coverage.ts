import { randomUUID } from 'node:crypto';
import type { CaptureCoverageState, DeviceCaptureDesiredState } from '@recapsy/contracts';
import type {
  CaptureCoverageSegmentRecord,
  CloseOpenCoverageSegmentInput,
  CoverageCloseReason,
  DeviceCaptureLivenessRecord,
  ExtendOpenCoverageSegmentInput,
  OpenCoverageSegmentInput,
  OpenCoverageSegmentRecord,
  RecoverHangingCoverageSegmentInput,
  UpsertDeviceCaptureLivenessInput,
} from '../types';
import type { SqliteDatabase, SqliteRow } from './driver';

export class SqliteCoveragePersistence {
  constructor(private readonly database: SqliteDatabase) {}

  async openCoverageSegment(input: OpenCoverageSegmentInput): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO device_capture_liveness (
          workspace_id, device_id, last_alive_at, desired_state,
          open_coverage_state, open_coverage_started_at, open_coverage_tick_count,
          open_coverage_interval_ms, updated_at
        ) VALUES (
          $workspaceId, $deviceId, $now, 'running',
          $coverageState, $startedAt, 1, $intervalMs, $now
        )
        ON CONFLICT(workspace_id, device_id) DO UPDATE SET
          open_coverage_state = excluded.open_coverage_state,
          open_coverage_started_at = excluded.open_coverage_started_at,
          open_coverage_tick_count = 1,
          open_coverage_interval_ms = excluded.open_coverage_interval_ms,
          updated_at = excluded.updated_at`,
      )
      .run({
        $coverageState: input.coverageState,
        $deviceId: input.deviceId,
        $intervalMs: input.intervalMs,
        $now: input.now,
        $startedAt: input.startedAt,
        $workspaceId: input.workspaceId,
      });
  }

  async extendOpenCoverageSegment(input: ExtendOpenCoverageSegmentInput): Promise<void> {
    this.database
      .prepare(
        `UPDATE device_capture_liveness
         SET open_coverage_tick_count = $tickCount,
             updated_at = $now
         WHERE workspace_id = $workspaceId
           AND device_id = $deviceId
           AND open_coverage_state IS NOT NULL`,
      )
      .run({
        $deviceId: input.deviceId,
        $now: input.now,
        $tickCount: input.tickCount,
        $workspaceId: input.workspaceId,
      });
  }

  async closeOpenCoverageSegment(
    input: CloseOpenCoverageSegmentInput,
  ): Promise<CaptureCoverageSegmentRecord | null> {
    let transactionOpen = false;
    try {
      this.database.run('BEGIN IMMEDIATE');
      transactionOpen = true;

      const record = this.closeOpenSegmentWithinTransaction(
        input.workspaceId,
        input.deviceId,
        input.endedAt,
        input.closeReason,
        input.now,
      );

      this.database.run(transactionOutcome(record));
      transactionOpen = false;
      return record;
    } catch (error) {
      if (transactionOpen) this.database.run('ROLLBACK');
      throw error;
    }
  }

  async recoverHangingCoverageSegment(input: RecoverHangingCoverageSegmentInput): Promise<void> {
    let transactionOpen = false;
    try {
      this.database.run('BEGIN IMMEDIATE');
      transactionOpen = true;

      const liveness = this.readLivenessRow(input.workspaceId, input.deviceId);
      if (!liveness || liveness.open_coverage_state === null) {
        this.database.run('ROLLBACK');
        transactionOpen = false;
        return;
      }

      const endedAt = liveness.last_alive_at ?? liveness.open_coverage_started_at ?? input.now;
      const record = this.closeOpenSegmentWithinTransaction(
        input.workspaceId,
        input.deviceId,
        endedAt,
        'inferred_on_recovery',
        input.now,
      );

      this.database.run(transactionOutcome(record));
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) this.database.run('ROLLBACK');
      throw error;
    }
  }

  async listPendingCoverageSegments(workspaceId?: string): Promise<CaptureCoverageSegmentRecord[]> {
    const rows = workspaceId
      ? this.database
          .prepare<CoverageSegmentRow>(
            `SELECT *
             FROM capture_coverage_segments
             WHERE workspace_id = $workspaceId AND sync_state = 'pending'
             ORDER BY created_at ASC, id ASC`,
          )
          .all({ $workspaceId: workspaceId })
      : this.database
          .prepare<CoverageSegmentRow>(
            `SELECT *
             FROM capture_coverage_segments
             WHERE sync_state = 'pending'
             ORDER BY created_at ASC, id ASC`,
          )
          .all();

    return rows.map(coverageSegmentFromRow);
  }

  async markCoverageSegmentsSynced(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;

    const parameters: Record<string, string> = {};
    const placeholders = ids.map((id, index) => {
      const parameter = `$id${index}`;
      parameters[parameter] = id;
      return parameter;
    });

    this.database
      .prepare(
        `UPDATE capture_coverage_segments
         SET sync_state = 'synced'
         WHERE id IN (${placeholders.join(', ')})`,
      )
      .run(parameters);
  }

  async getOpenCoverageSegment(
    workspaceId: string,
    deviceId: string,
  ): Promise<OpenCoverageSegmentRecord | null> {
    const liveness = this.readLivenessRow(workspaceId, deviceId);
    return liveness ? openSegmentFromRow(liveness) : null;
  }

  async getDeviceCaptureLiveness(
    workspaceId: string,
    deviceId: string,
  ): Promise<DeviceCaptureLivenessRecord | null> {
    const row = this.readLivenessRow(workspaceId, deviceId);
    return row ? livenessFromRow(row) : null;
  }

  async upsertDeviceCaptureLiveness(
    input: UpsertDeviceCaptureLivenessInput,
  ): Promise<DeviceCaptureLivenessRecord> {
    this.database
      .prepare(
        `INSERT INTO device_capture_liveness (
          workspace_id, device_id, last_alive_at, desired_state, updated_at
        ) VALUES (
          $workspaceId, $deviceId, $lastAliveAt, $desiredState, $now
        )
        ON CONFLICT(workspace_id, device_id) DO UPDATE SET
          last_alive_at = excluded.last_alive_at,
          desired_state = excluded.desired_state,
          updated_at = excluded.updated_at`,
      )
      .run({
        $deviceId: input.deviceId,
        $desiredState: input.desiredState,
        $lastAliveAt: input.lastAliveAt,
        $now: input.now,
        $workspaceId: input.workspaceId,
      });

    return {
      deviceId: input.deviceId,
      desiredState: input.desiredState,
      lastAliveAt: input.lastAliveAt,
      updatedAt: input.now,
      workspaceId: input.workspaceId,
    };
  }

  private closeOpenSegmentWithinTransaction(
    workspaceId: string,
    deviceId: string,
    endedAt: string,
    closeReason: CoverageCloseReason,
    now: string,
  ): CaptureCoverageSegmentRecord | null {
    const liveness = this.readLivenessRow(workspaceId, deviceId);
    if (
      !liveness ||
      liveness.open_coverage_state === null ||
      liveness.open_coverage_started_at === null ||
      liveness.open_coverage_tick_count === null ||
      liveness.open_coverage_interval_ms === null
    ) {
      return null;
    }

    const record: CaptureCoverageSegmentRecord = {
      closeReason,
      coverageState: liveness.open_coverage_state,
      createdAt: now,
      deviceId,
      endedAt,
      id: randomUUID(),
      intervalMs: liveness.open_coverage_interval_ms,
      startedAt: liveness.open_coverage_started_at,
      syncState: 'pending',
      tickCount: liveness.open_coverage_tick_count,
      workspaceId,
    };

    this.database
      .prepare(
        `INSERT INTO capture_coverage_segments (
          id, workspace_id, device_id, coverage_state, started_at, ended_at,
          tick_count, interval_ms, close_reason, sync_state, created_at
        ) VALUES (
          $id, $workspaceId, $deviceId, $coverageState, $startedAt, $endedAt,
          $tickCount, $intervalMs, $closeReason, 'pending', $createdAt
        )`,
      )
      .run({
        $closeReason: record.closeReason,
        $coverageState: record.coverageState,
        $createdAt: record.createdAt,
        $deviceId: record.deviceId,
        $endedAt: record.endedAt,
        $id: record.id,
        $intervalMs: record.intervalMs,
        $startedAt: record.startedAt,
        $tickCount: record.tickCount,
        $workspaceId: record.workspaceId,
      });

    this.database
      .prepare(
        `UPDATE device_capture_liveness
         SET open_coverage_state = NULL,
             open_coverage_started_at = NULL,
             open_coverage_tick_count = NULL,
             open_coverage_interval_ms = NULL,
             updated_at = $now
         WHERE workspace_id = $workspaceId AND device_id = $deviceId`,
      )
      .run({ $deviceId: deviceId, $now: now, $workspaceId: workspaceId });

    return record;
  }

  private readLivenessRow(workspaceId: string, deviceId: string): LivenessRow | null {
    return this.database
      .prepare<LivenessRow>(
        `SELECT *
         FROM device_capture_liveness
         WHERE workspace_id = $workspaceId AND device_id = $deviceId
         LIMIT 1`,
      )
      .get({ $deviceId: deviceId, $workspaceId: workspaceId });
  }
}

type LivenessRow = SqliteRow & {
  workspace_id: string;
  device_id: string;
  last_alive_at: string;
  desired_state: DeviceCaptureDesiredState;
  open_coverage_state: CaptureCoverageState | null;
  open_coverage_started_at: string | null;
  open_coverage_tick_count: number | null;
  open_coverage_interval_ms: number | null;
  updated_at: string;
};

type CoverageSegmentRow = SqliteRow & {
  id: string;
  workspace_id: string;
  device_id: string;
  coverage_state: CaptureCoverageState;
  started_at: string;
  ended_at: string;
  tick_count: number;
  interval_ms: number;
  close_reason: CoverageCloseReason;
  sync_state: 'pending' | 'synced';
  created_at: string;
};

function coverageSegmentFromRow(row: CoverageSegmentRow): CaptureCoverageSegmentRecord {
  return {
    closeReason: row.close_reason,
    coverageState: row.coverage_state,
    createdAt: row.created_at,
    deviceId: row.device_id,
    endedAt: row.ended_at,
    id: row.id,
    intervalMs: row.interval_ms,
    startedAt: row.started_at,
    syncState: row.sync_state,
    tickCount: row.tick_count,
    workspaceId: row.workspace_id,
  };
}

function openSegmentFromRow(row: LivenessRow): OpenCoverageSegmentRecord | null {
  if (
    row.open_coverage_state === null ||
    row.open_coverage_started_at === null ||
    row.open_coverage_tick_count === null ||
    row.open_coverage_interval_ms === null
  ) {
    return null;
  }

  return {
    coverageState: row.open_coverage_state,
    intervalMs: row.open_coverage_interval_ms,
    startedAt: row.open_coverage_started_at,
    tickCount: row.open_coverage_tick_count,
  };
}

function livenessFromRow(row: LivenessRow): DeviceCaptureLivenessRecord {
  return {
    deviceId: row.device_id,
    desiredState: row.desired_state,
    lastAliveAt: row.last_alive_at,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
  };
}

function transactionOutcome(record: unknown): 'COMMIT' | 'ROLLBACK' {
  return record ? 'COMMIT' : 'ROLLBACK';
}
