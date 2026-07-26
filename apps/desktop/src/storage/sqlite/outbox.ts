import { randomUUID } from 'node:crypto';
import { cloneOutboxJob, createPendingOutboxJob, requiresLocalAssetBytes } from '../outbox-values';
import type {
  ClaimRetryableOutboxJobInput,
  OperationalStoreError,
  OperationalStoreResult,
  OutboxJob,
  OutboxJobCreateInput,
  OutboxJobListFilter,
  OutboxJobState,
  OutboxJobStateUpdate,
  OutboxQueueSummary,
  OutboxSafeErrorInput,
  OutboxTerminalState,
  OutboxTerminalUpdate,
  RecoverInterruptedOutboxJobInput,
  ReleaseOutboxJobInput,
  RequeueTerminalOutboxJobsInput,
  StoredOcrResult,
} from '../types';
import type { SqliteDatabase, SqliteRow } from './driver';
import { parseJson } from './serialization';

export { cloneOutboxJob, createPendingOutboxJob, outboxJobMatchesInput } from '../outbox-values';

const TERMINAL_OUTBOX_STATES = new Set<OutboxJobState>([
  'synced',
  'blocked',
  'failed',
  'cancelled',
]);
const OUTBOX_LEASE_DURATION_MS = 60_000;

export class SqliteOutboxPersistence {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly maxActiveJobs?: number,
  ) {}

  async create(job: OutboxJobCreateInput): Promise<OperationalStoreResult<OutboxJob>> {
    if (this.hasIdempotencyKey(job.workspaceId, job.idempotencyKey)) {
      return failure(idempotencyKeyConflict());
    }

    if (this.capacityReached()) {
      return failure(capacityExceeded());
    }

    const created = createPendingOutboxJob(job);

    try {
      this.insert(created);
    } catch (error) {
      const mapped = mapCreateOutboxConstraintError(error);
      if (mapped) return failure(mapped);
      throw error;
    }

    return success(cloneOutboxJob(created));
  }

  async get(id: string): Promise<OutboxJob | null> {
    return this.findById(id);
  }

  async list(filter: OutboxJobListFilter = {}): Promise<OutboxJob[]> {
    const rows =
      filter.workspaceId && filter.state
        ? this.database
            .prepare<OutboxJobRow>(
              `SELECT *
               FROM outbox_jobs
               WHERE workspace_id = $workspaceId AND state = $state
               ORDER BY created_at ASC, id ASC`,
            )
            .all({ $state: filter.state, $workspaceId: filter.workspaceId })
        : filter.workspaceId
          ? this.database
              .prepare<OutboxJobRow>(
                `SELECT *
                 FROM outbox_jobs
                 WHERE workspace_id = $workspaceId
                 ORDER BY created_at ASC, id ASC`,
              )
              .all({ $workspaceId: filter.workspaceId })
          : filter.state
            ? this.database
                .prepare<OutboxJobRow>(
                  `SELECT *
                   FROM outbox_jobs
                   WHERE state = $state
                   ORDER BY created_at ASC, id ASC`,
                )
                .all({ $state: filter.state })
            : this.database
                .prepare<OutboxJobRow>('SELECT * FROM outbox_jobs ORDER BY created_at ASC, id ASC')
                .all();

    return rows.map(outboxJobFromRow);
  }

  async listInterrupted(workspaceId?: string): Promise<OutboxJob[]> {
    const rows = workspaceId
      ? this.database
          .prepare<OutboxJobRow>(
            `SELECT *
             FROM outbox_jobs
             WHERE workspace_id = $workspaceId
               AND state IN ('syncing', 'result_pending')
             ORDER BY created_at ASC, id ASC`,
          )
          .all({ $workspaceId: workspaceId })
      : this.database
          .prepare<OutboxJobRow>(
            `SELECT *
             FROM outbox_jobs
             WHERE state IN ('syncing', 'result_pending')
             ORDER BY created_at ASC, id ASC`,
          )
          .all();

    return rows.map(outboxJobFromRow);
  }

  async listLocalAssetDependencies(workspaceId?: string): Promise<OutboxJob[]> {
    const rows = workspaceId
      ? this.database
          .prepare<OutboxJobRow>(
            `SELECT *
             FROM outbox_jobs
             WHERE workspace_id = $workspaceId
               AND state IN ('pending', 'syncing')
             ORDER BY created_at ASC, id ASC`,
          )
          .all({ $workspaceId: workspaceId })
      : this.database
          .prepare<OutboxJobRow>(
            `SELECT *
             FROM outbox_jobs
             WHERE state IN ('pending', 'syncing')
             ORDER BY created_at ASC, id ASC`,
          )
          .all();

    return rows.map(outboxJobFromRow).filter(requiresLocalAssetBytes);
  }

  async summary(input: {
    minuteAgo: string;
    now: string;
    workspaceId: string;
  }): Promise<OutboxQueueSummary> {
    const row = this.database
      .prepare<{
        blocked: number;
        completed_per_minute: number;
        failed: number;
        input_per_minute: number;
        next_retry_at: string | null;
        oldest_active_created_at: string | null;
        pending: number;
        processing: number;
        retrying: number;
        syncing: number;
      }>(
        `SELECT
           COALESCE(SUM(CASE WHEN state = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked,
           COALESCE(SUM(CASE
             WHEN state = 'synced' AND updated_at >= $minuteAgo AND updated_at <= $now THEN 1
             ELSE 0
           END), 0) AS completed_per_minute,
           COALESCE(SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
           COALESCE(SUM(CASE WHEN created_at >= $minuteAgo AND created_at <= $now THEN 1 ELSE 0 END), 0)
             AS input_per_minute,
           MIN(CASE WHEN state = 'pending' AND next_retry_at IS NOT NULL THEN next_retry_at END)
             AS next_retry_at,
           MIN(CASE
             WHEN state IN ('pending', 'syncing', 'result_pending') THEN created_at
             ELSE NULL
           END) AS oldest_active_created_at,
           COALESCE(SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
           COALESCE(SUM(CASE WHEN state IN ('syncing', 'result_pending') THEN 1 ELSE 0 END), 0)
             AS processing,
           COALESCE(SUM(CASE WHEN state = 'pending' AND next_retry_at IS NOT NULL THEN 1 ELSE 0 END), 0)
             AS retrying,
           COALESCE(SUM(CASE WHEN state IN ('syncing', 'result_pending') THEN 1 ELSE 0 END), 0)
             AS syncing
         FROM outbox_jobs
         WHERE workspace_id = $workspaceId`,
      )
      .get({ $minuteAgo: input.minuteAgo, $now: input.now, $workspaceId: input.workspaceId });
    const latestError = this.database
      .prepare<{ last_safe_error_json: string }>(
        `SELECT last_safe_error_json
         FROM outbox_jobs
         WHERE workspace_id = $workspaceId
           AND last_safe_error_json IS NOT NULL
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get({ $workspaceId: input.workspaceId });

    return {
      blocked: row?.blocked ?? 0,
      completedPerMinute: row?.completed_per_minute ?? 0,
      failed: row?.failed ?? 0,
      inputPerMinute: row?.input_per_minute ?? 0,
      pending: row?.pending ?? 0,
      processing: row?.processing ?? 0,
      retrying: row?.retrying ?? 0,
      syncing: row?.syncing ?? 0,
      ...(latestError ? { lastSafeError: parseJson(latestError.last_safe_error_json) } : {}),
      ...(row?.next_retry_at ? { nextRetryAt: row.next_retry_at } : {}),
      ...(row?.oldest_active_created_at
        ? { oldestActiveCreatedAt: row.oldest_active_created_at }
        : {}),
    };
  }

  async updateState(
    id: string,
    update: OutboxJobStateUpdate,
  ): Promise<OperationalStoreResult<OutboxJob>> {
    const row = this.database
      .prepare<OutboxJobRow>(
        `UPDATE outbox_jobs
         SET state = $state,
             updated_at = $updatedAt,
             next_retry_at = COALESCE($nextRetryAt, next_retry_at),
             locked_at = CASE WHEN $state = 'syncing' THEN $updatedAt ELSE locked_at END,
             server_capture_id = COALESCE($serverCaptureId, server_capture_id),
             ocr_result_json = COALESCE($ocrResultJson, ocr_result_json)
         WHERE id = $id
           AND state NOT IN ('synced', 'blocked', 'failed', 'cancelled')
           AND (($leaseToken IS NULL AND lease_token IS NULL) OR lease_token = $leaseToken)
         RETURNING *`,
      )
      .get({
        $id: id,
        $nextRetryAt: update.nextRetryAt ?? null,
        $ocrResultJson: update.ocrResult ? JSON.stringify(update.ocrResult) : null,
        $leaseToken: update.leaseToken ?? null,
        $serverCaptureId: update.serverCaptureId ?? null,
        $state: update.state,
        $updatedAt: update.now,
      });

    return row
      ? success(outboxJobFromRow(row))
      : failure(this.missingOrTerminalError(id, terminalTransitionConflict()));
  }

  async claimNextRetryable(input: ClaimRetryableOutboxJobInput): Promise<OutboxJob | null> {
    const row = this.database
      .prepare<OutboxJobRow>(
        `UPDATE outbox_jobs
         SET state = 'syncing',
             next_retry_at = NULL,
             locked_at = $now,
             lease_token = $leaseToken,
             lease_expires_at = $leaseExpiresAt,
             updated_at = $now
         WHERE id = (
           SELECT id
           FROM outbox_jobs
           WHERE workspace_id = $workspaceId
             AND state = 'pending'
             AND attempt < $maxAttempts
             AND (next_retry_at IS NULL OR next_retry_at <= $now)
           ORDER BY COALESCE(next_retry_at, created_at) ASC, created_at ASC, id ASC
           LIMIT 1
         )
         RETURNING *`,
      )
      .get({
        $maxAttempts: input.maxAttempts,
        $leaseExpiresAt: new Date(Date.parse(input.now) + OUTBOX_LEASE_DURATION_MS).toISOString(),
        $leaseToken: randomUUID(),
        $now: input.now,
        $workspaceId: input.workspaceId,
      });

    return row ? outboxJobFromRow(row) : null;
  }

  async markTerminal(
    id: string,
    update: OutboxTerminalUpdate,
  ): Promise<OperationalStoreResult<OutboxJob>> {
    const row = this.database
      .prepare<OutboxJobRow>(
        `UPDATE outbox_jobs
         SET state = $state,
             updated_at = $updatedAt,
             next_retry_at = NULL,
             locked_at = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             server_capture_id = $serverCaptureId,
             last_safe_error_json = $lastSafeErrorJson,
             terminal_reason = $terminalReason
         WHERE id = $id
           AND state NOT IN ('synced', 'blocked', 'failed', 'cancelled')
           AND (($leaseToken IS NULL AND lease_token IS NULL) OR lease_token = $leaseToken)
         RETURNING *`,
      )
      .get({
        $id: id,
        $lastSafeErrorJson: update.lastSafeError ? JSON.stringify(update.lastSafeError) : null,
        $leaseToken: update.leaseToken ?? null,
        $serverCaptureId: update.serverCaptureId ?? null,
        $state: update.state,
        $terminalReason: update.reason,
        $updatedAt: update.now,
      });

    return row
      ? success(outboxJobFromRow(row))
      : failure(
          this.missingOrTerminalError(id, {
            code: 'terminal_state_conflict',
            message: 'Terminal outbox jobs cannot transition to another terminal state.',
          }),
        );
  }

  async recordSafeError(
    id: string,
    input: OutboxSafeErrorInput,
  ): Promise<OperationalStoreResult<OutboxJob>> {
    const row = this.database
      .prepare<OutboxJobRow>(
        `UPDATE outbox_jobs
         SET state = CASE
               WHEN $retryable = 1 AND attempt + 1 < $maxAttempts THEN 'pending'
               ELSE 'failed'
             END,
             attempt = attempt + 1,
             updated_at = $updatedAt,
             next_retry_at = CASE
               WHEN $retryable = 1 AND attempt + 1 < $maxAttempts THEN $retryAt
               ELSE NULL
             END,
             locked_at = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             last_safe_error_json = $lastSafeErrorJson,
             terminal_reason = CASE
               WHEN $retryable = 1 AND attempt + 1 < $maxAttempts THEN NULL
               ELSE $terminalReason
             END
         WHERE id = $id
           AND state NOT IN ('synced', 'blocked', 'failed', 'cancelled')
           AND (($leaseToken IS NULL AND lease_token IS NULL) OR lease_token = $leaseToken)
         RETURNING *`,
      )
      .get({
        $id: id,
        $lastSafeErrorJson: JSON.stringify({
          code: input.code,
          message: input.message,
          retryable: input.retryable,
        }),
        $leaseToken: input.leaseToken ?? null,
        $maxAttempts: input.maxAttempts,
        $retryAt: input.retryAt ?? null,
        $retryable: input.retryable ? 1 : 0,
        $terminalReason: input.code,
        $updatedAt: input.now,
      });

    return row
      ? success(outboxJobFromRow(row))
      : failure(
          this.missingOrTerminalError(id, {
            code: 'terminal_state_conflict',
            message: 'Terminal outbox jobs cannot be retried.',
          }),
        );
  }

  async recoverInterrupted(
    input: RecoverInterruptedOutboxJobInput,
  ): Promise<OperationalStoreResult<OutboxJob>> {
    const row = this.database
      .prepare<OutboxJobRow>(
        `UPDATE outbox_jobs
         SET state = 'pending',
             updated_at = $updatedAt,
             next_retry_at = $nextRetryAt,
             locked_at = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             last_safe_error_json = $lastSafeErrorJson,
             terminal_reason = NULL
         WHERE id = $id
           AND state IN ('syncing', 'result_pending')
           AND (($leaseToken IS NULL AND lease_token IS NULL) OR lease_token = $leaseToken)
         RETURNING *`,
      )
      .get({
        $id: input.id,
        $lastSafeErrorJson: JSON.stringify(input.lastSafeError),
        $leaseToken: input.leaseToken ?? null,
        $nextRetryAt: input.nextRetryAt,
        $updatedAt: input.now,
      });

    return row
      ? success(outboxJobFromRow(row))
      : failure(
          this.missingOrTerminalError(input.id, {
            code: 'terminal_state_conflict',
            message: 'Only interrupted outbox jobs can be recovered at startup.',
          }),
        );
  }

  async release(input: ReleaseOutboxJobInput): Promise<OperationalStoreResult<OutboxJob>> {
    const row = this.database
      .prepare<OutboxJobRow>(
        `UPDATE outbox_jobs
         SET state = 'pending',
             updated_at = $updatedAt,
             next_retry_at = $updatedAt,
             locked_at = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             last_safe_error_json = $lastSafeErrorJson,
             terminal_reason = NULL
         WHERE id = $id
           AND state NOT IN ('synced', 'blocked', 'failed', 'cancelled')
           AND (($leaseToken IS NULL AND lease_token IS NULL) OR lease_token = $leaseToken)
         RETURNING *`,
      )
      .get({
        $id: input.id,
        $lastSafeErrorJson: JSON.stringify(input.lastSafeError),
        $leaseToken: input.leaseToken ?? null,
        $updatedAt: input.now,
      });

    return row
      ? success(outboxJobFromRow(row))
      : failure(this.missingOrTerminalError(input.id, terminalTransitionConflict()));
  }

  async requeueTerminal(input: RequeueTerminalOutboxJobsInput): Promise<number> {
    const rows = this.database
      .prepare<{ id: string }>(
        `UPDATE outbox_jobs
         SET state = 'pending',
             attempt = 0,
             updated_at = $updatedAt,
             next_retry_at = $updatedAt,
             locked_at = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             last_safe_error_json = NULL,
             terminal_reason = NULL
         WHERE workspace_id = $workspaceId
           AND state IN ('failed', 'blocked')
         RETURNING id`,
      )
      .all({ $updatedAt: input.now, $workspaceId: input.workspaceId });
    return rows.length;
  }

  capacityReached(): boolean {
    if (this.maxActiveJobs === undefined) return false;
    return this.activeJobCount() >= this.maxActiveJobs;
  }

  findById(id: string): OutboxJob | null {
    const row = this.database
      .prepare<OutboxJobRow>('SELECT * FROM outbox_jobs WHERE id = $id LIMIT 1')
      .get({ $id: id });
    return row ? outboxJobFromRow(row) : null;
  }

  hasId(id: string): boolean {
    return Boolean(
      this.database
        .prepare<{ id: string }>('SELECT id FROM outbox_jobs WHERE id = $id LIMIT 1')
        .get({ $id: id }),
    );
  }

  findByIdempotencyKey(workspaceId: string, idempotencyKey: string): OutboxJob | null {
    const row = this.database
      .prepare<OutboxJobRow>(
        `SELECT *
         FROM outbox_jobs
         WHERE workspace_id = $workspaceId AND idempotency_key = $idempotencyKey
         LIMIT 1`,
      )
      .get({ $idempotencyKey: idempotencyKey, $workspaceId: workspaceId });
    return row ? outboxJobFromRow(row) : null;
  }

  hasIdempotencyKey(workspaceId: string, idempotencyKey: string): boolean {
    return Boolean(
      this.database
        .prepare<{ id: string }>(
          `SELECT id
           FROM outbox_jobs
           WHERE workspace_id = $workspaceId AND idempotency_key = $idempotencyKey
           LIMIT 1`,
        )
        .get({ $idempotencyKey: idempotencyKey, $workspaceId: workspaceId }),
    );
  }

  insert(job: OutboxJob): void {
    this.database
      .prepare(
        `INSERT INTO outbox_jobs (
          id, workspace_id, device_id, asset_ref_id, idempotency_key, payload_hash,
          capture_json, state, attempt, created_at, updated_at, next_retry_at
        ) VALUES (
          $id, $workspaceId, $deviceId, $assetRefId, $idempotencyKey, $payloadHash,
          $captureJson, $state, $attempt, $createdAt, $updatedAt, $nextRetryAt
        )`,
      )
      .run({
        $assetRefId: job.assetRefId,
        $attempt: job.attempt,
        $captureJson: JSON.stringify(job.capture),
        $createdAt: job.createdAt,
        $deviceId: job.deviceId,
        $id: job.id,
        $idempotencyKey: job.idempotencyKey,
        $nextRetryAt: job.nextRetryAt ?? null,
        $payloadHash: job.payloadHash,
        $state: job.state,
        $updatedAt: job.updatedAt,
        $workspaceId: job.workspaceId,
      });
  }

  private activeJobCount(): number {
    return (
      this.database
        .prepare<{ count: number }>(
          `SELECT queued_jobs AS count
           FROM operational_store_statistics
           WHERE id = 1`,
        )
        .get()?.count ?? 0
    );
  }

  private missingOrTerminalError(
    id: string,
    terminalError: OperationalStoreError,
  ): OperationalStoreError {
    const existing = this.database
      .prepare<{ state: OutboxJobState; lease_token?: string | null }>(
        `SELECT state
                , lease_token
         FROM outbox_jobs
         WHERE id = $id
         LIMIT 1`,
      )
      .get({ $id: id });

    if (!existing) return { code: 'outbox_job_not_found', message: 'Outbox job was not found.' };
    if (isTerminalOutboxState(existing.state)) return terminalError;
    if (existing.lease_token) {
      return {
        code: 'outbox_lease_lost',
        message: 'Outbox job lease is no longer held by this worker.',
      };
    }
    return {
      code: 'terminal_state_conflict',
      message: 'Outbox job state changed before the update could be applied.',
    };
  }
}

export function mapCreateOutboxConstraintError(error: unknown): OperationalStoreError | null {
  if (!(error instanceof Error)) return null;
  const text = [error.name, error.message, 'code' in error ? String(error.code) : '']
    .join(' ')
    .toLowerCase();
  if (!text.includes('constraint')) return null;

  if (text.includes('outbox_jobs.id')) {
    return { code: 'outbox_job_id_conflict', message: 'Outbox job id already exists.' };
  }
  if (
    text.includes('outbox_jobs.workspace_id') ||
    text.includes('outbox_jobs.idempotency_key') ||
    text.includes('outbox_jobs.workspace_id, outbox_jobs.idempotency_key')
  ) {
    return {
      code: 'idempotency_key_conflict',
      message: 'Outbox idempotency key already exists for this workspace.',
    };
  }
  return null;
}

type OutboxJobRow = SqliteRow & {
  id: string;
  workspace_id: string;
  device_id: string;
  asset_ref_id: string;
  idempotency_key: string;
  payload_hash: string;
  capture_json: string;
  state: OutboxJobState;
  attempt: number;
  created_at: string;
  updated_at: string;
  next_retry_at?: string | null;
  locked_at?: string | null;
  lease_token?: string | null;
  lease_expires_at?: string | null;
  server_capture_id?: string | null;
  ocr_result_json?: string | null;
  last_safe_error_json?: string | null;
  terminal_reason?: string | null;
};

function outboxJobFromRow(row: OutboxJobRow): OutboxJob {
  return cloneOutboxJob({
    assetRefId: row.asset_ref_id,
    attempt: row.attempt,
    capture: parseJson<OutboxJob['capture']>(row.capture_json),
    createdAt: row.created_at,
    deviceId: row.device_id,
    id: row.id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    state: row.state,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
    ...(row.last_safe_error_json
      ? { lastSafeError: parseJson<OutboxJob['lastSafeError']>(row.last_safe_error_json) }
      : {}),
    ...(row.locked_at ? { lockedAt: row.locked_at } : {}),
    ...(row.lease_token ? { leaseToken: row.lease_token } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.next_retry_at ? { nextRetryAt: row.next_retry_at } : {}),
    ...(row.server_capture_id ? { serverCaptureId: row.server_capture_id } : {}),
    ...(row.ocr_result_json ? { ocrResult: parseJson<StoredOcrResult>(row.ocr_result_json) } : {}),
    ...(row.terminal_reason ? { terminalReason: row.terminal_reason } : {}),
  });
}

function isTerminalOutboxState(state: OutboxJobState): state is OutboxTerminalState {
  return TERMINAL_OUTBOX_STATES.has(state);
}

function capacityExceeded(): OperationalStoreError {
  return { code: 'capacity_exceeded', message: 'Outbox active job capacity has been reached.' };
}

function idempotencyKeyConflict(): OperationalStoreError {
  return {
    code: 'idempotency_key_conflict',
    message: 'Outbox idempotency key already exists for this workspace.',
  };
}

function terminalTransitionConflict(): OperationalStoreError {
  return {
    code: 'terminal_state_conflict',
    message: 'Terminal outbox jobs cannot transition to another state.',
  };
}

function success<T>(value: T): OperationalStoreResult<T> {
  return { ok: true, value };
}

function failure<T>(error: OperationalStoreError): OperationalStoreResult<T> {
  return { error, ok: false };
}
