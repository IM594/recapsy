import type { SqliteDatabase, SqliteRow } from './sqlite-driver';
import type {
  AssetCacheRef,
  CaptureOutboxEntryCreateInput,
  ClaimRetryableOutboxJobInput,
  HelperRuntimeState,
  OperationalStoreError,
  OperationalStoreResult,
  OperationalStoreSnapshot,
  OutboxJob,
  OutboxJobCreateInput,
  OutboxJobListFilter,
  OutboxJobState,
  OutboxJobStateUpdate,
  OutboxSafeErrorInput,
  OutboxTerminalState,
  OutboxTerminalUpdate,
  PolicyCacheEntry,
  PolicyCacheRead,
  PolicyCacheReadOptions,
  RecoverInterruptedOutboxJobInput,
  SettingsCache,
  StoredOcrResult,
  SyncCursor,
  SyncCursorKind,
  UpdateAssetRefAvailabilityInput,
} from './types';

export type SqliteStoreOptions = {
  database: SqliteDatabase;
  maxActiveOutboxJobs?: number;
};

const SCHEMA_VERSION = 2;
const HELPER_STATE_KEY = 'runtime';
const TERMINAL_OUTBOX_STATES = new Set<OutboxJobState>([
  'synced',
  'blocked',
  'failed',
  'cancelled',
]);

export function createSqliteStore(options: SqliteStoreOptions) {
  return new SqliteOperationalStore(options);
}

export function migrateSqliteStore(database: SqliteDatabase): void {
  database.run('PRAGMA foreign_keys = ON');
  database.run('PRAGMA journal_mode = WAL');
  database.run('PRAGMA busy_timeout = 5000');

  for (const statement of schemaStatements) {
    database.run(statement);
  }

  ensureAssetAvailabilityColumns(database);
  migrateOutboxJobsToV2(database);

  database.run(
    `INSERT OR IGNORE INTO schema_migrations (version, applied_at)
     VALUES ($version, $appliedAt)`,
    {
      $appliedAt: new Date().toISOString(),
      $version: SCHEMA_VERSION,
    },
  );
}

function ensureAssetAvailabilityColumns(database: SqliteDatabase): void {
  const columns = new Set(
    database
      .prepare<{ name: string }>('PRAGMA table_info(asset_cache_refs)')
      .all()
      .map((column) => column.name),
  );

  if (!columns.has('availability_state')) {
    database.run(
      `ALTER TABLE asset_cache_refs
       ADD COLUMN availability_state TEXT NOT NULL DEFAULT 'available'
       CHECK (availability_state IN ('available', 'missing', 'unreadable'))`,
    );
  }

  if (!columns.has('availability_checked_at')) {
    database.run('ALTER TABLE asset_cache_refs ADD COLUMN availability_checked_at TEXT');
  }

  if (!columns.has('availability_safe_error_json')) {
    database.run(
      `ALTER TABLE asset_cache_refs
       ADD COLUMN availability_safe_error_json TEXT
       CHECK (
         availability_safe_error_json IS NULL OR json_valid(availability_safe_error_json)
       )`,
    );
  }
}

/**
 * Rebuilds `outbox_jobs` into its v2 shape on an existing (v1) database: drops
 * the dead `server_ocr_job_id` column, adds `ocr_result_json`, and remaps the
 * retired states — `ocr_wait → pending` (clearing next_retry_at/locked_at so
 * the row replays immediately) and `uploading → syncing`. Terminal rows copy
 * across untouched, so no queued work is lost. SQLite cannot ALTER a CHECK
 * constraint, so this is a full table rebuild inside one transaction. Fresh
 * installs already have the v2 shape from `schemaStatements`, detected by the
 * absence of the legacy `server_ocr_job_id` column, making this a no-op. See
 * `docs/design/OCR_OUTBOX_STATE_MACHINE.md` §2.3.
 */
function migrateOutboxJobsToV2(database: SqliteDatabase): void {
  const columns = new Set(
    database
      .prepare<{ name: string }>('PRAGMA table_info(outbox_jobs)')
      .all()
      .map((column) => column.name),
  );

  if (!columns.has('server_ocr_job_id')) {
    return;
  }

  let transactionOpen = false;

  try {
    database.run('BEGIN IMMEDIATE');
    transactionOpen = true;

    database.run(buildOutboxJobsTable('outbox_jobs__v2', false));
    database.run(
      `INSERT INTO outbox_jobs__v2 (
        id,
        workspace_id,
        device_id,
        asset_ref_id,
        idempotency_key,
        payload_hash,
        capture_json,
        state,
        attempt,
        created_at,
        updated_at,
        next_retry_at,
        locked_at,
        server_capture_id,
        ocr_result_json,
        last_safe_error_json,
        terminal_reason
      )
      SELECT
        id,
        workspace_id,
        device_id,
        asset_ref_id,
        idempotency_key,
        payload_hash,
        capture_json,
        CASE state
          WHEN 'ocr_wait' THEN 'pending'
          WHEN 'uploading' THEN 'syncing'
          ELSE state
        END,
        attempt,
        created_at,
        updated_at,
        CASE WHEN state = 'ocr_wait' THEN NULL ELSE next_retry_at END,
        CASE WHEN state = 'ocr_wait' THEN NULL ELSE locked_at END,
        server_capture_id,
        NULL,
        last_safe_error_json,
        terminal_reason
      FROM outbox_jobs`,
    );
    database.run('DROP TABLE outbox_jobs');
    database.run('ALTER TABLE outbox_jobs__v2 RENAME TO outbox_jobs');
    database.run(OUTBOX_JOBS_INDEX_STATEMENT);

    database.run('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      database.run('ROLLBACK');
    }

    throw error;
  }
}

class SqliteOperationalStore {
  constructor(private readonly options: SqliteStoreOptions) {}

  async initialize(): Promise<void> {
    migrateSqliteStore(this.options.database);
  }

  close(): void {
    this.options.database.close();
  }

  async createOutboxJob(job: OutboxJobCreateInput): Promise<OperationalStoreResult<OutboxJob>> {
    const activeJobCount = this.options.database
      .prepare<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM outbox_jobs
         WHERE state NOT IN ('synced', 'blocked', 'failed', 'cancelled')`,
      )
      .get()?.count;

    if (
      this.options.maxActiveOutboxJobs !== undefined &&
      (activeJobCount ?? 0) >= this.options.maxActiveOutboxJobs
    ) {
      return failure({
        code: 'capacity_exceeded',
        message: 'Outbox active job capacity has been reached.',
      });
    }

    const conflict = this.options.database
      .prepare<{ id: string }>(
        `SELECT id
         FROM outbox_jobs
         WHERE workspace_id = $workspaceId AND idempotency_key = $idempotencyKey
         LIMIT 1`,
      )
      .get({
        $idempotencyKey: job.idempotencyKey,
        $workspaceId: job.workspaceId,
      });

    if (conflict) {
      return failure({
        code: 'idempotency_key_conflict',
        message: 'Outbox idempotency key already exists for this workspace.',
      });
    }

    const created: OutboxJob = {
      assetRefId: job.assetRefId,
      attempt: 0,
      capture: normalizeCapturePayload(job),
      createdAt: job.createdAt,
      deviceId: job.deviceId,
      id: job.id,
      idempotencyKey: job.idempotencyKey,
      payloadHash: job.payloadHash,
      state: 'pending',
      updatedAt: job.createdAt,
      workspaceId: job.workspaceId,
      ...(job.nextRetryAt ? { nextRetryAt: job.nextRetryAt } : {}),
    };

    try {
      this.options.database
        .prepare(
          `INSERT INTO outbox_jobs (
          id,
          workspace_id,
          device_id,
          asset_ref_id,
          idempotency_key,
          payload_hash,
          capture_json,
          state,
          attempt,
          created_at,
          updated_at,
          next_retry_at
        ) VALUES (
          $id,
          $workspaceId,
          $deviceId,
          $assetRefId,
          $idempotencyKey,
          $payloadHash,
          $captureJson,
          $state,
          $attempt,
          $createdAt,
          $updatedAt,
          $nextRetryAt
        )`,
        )
        .run({
          $assetRefId: created.assetRefId,
          $attempt: created.attempt,
          $captureJson: JSON.stringify(created.capture),
          $createdAt: created.createdAt,
          $deviceId: created.deviceId,
          $id: created.id,
          $idempotencyKey: created.idempotencyKey,
          $nextRetryAt: created.nextRetryAt ?? null,
          $payloadHash: created.payloadHash,
          $state: created.state,
          $updatedAt: created.updatedAt,
          $workspaceId: created.workspaceId,
        });
    } catch (error) {
      const mapped = mapCreateOutboxConstraintError(error);

      if (mapped) {
        return failure(mapped);
      }

      throw error;
    }

    return success(cloneOutboxJob(created));
  }

  async createCaptureOutboxEntry(
    entry: CaptureOutboxEntryCreateInput,
  ): Promise<OperationalStoreResult<OutboxJob>> {
    let transactionOpen = false;

    try {
      this.options.database.run('BEGIN IMMEDIATE');
      transactionOpen = true;

      const activeJobCount = this.options.database
        .prepare<{ count: number }>(
          `SELECT COUNT(*) AS count
           FROM outbox_jobs
           WHERE state NOT IN ('synced', 'blocked', 'failed', 'cancelled')`,
        )
        .get()?.count;

      if (
        this.options.maxActiveOutboxJobs !== undefined &&
        (activeJobCount ?? 0) >= this.options.maxActiveOutboxJobs
      ) {
        this.options.database.run('ROLLBACK');
        transactionOpen = false;
        return failure({
          code: 'capacity_exceeded',
          message: 'Outbox active job capacity has been reached.',
        });
      }

      const conflict = this.options.database
        .prepare<OutboxJobRow>(
          `SELECT *
           FROM outbox_jobs
           WHERE workspace_id = $workspaceId AND idempotency_key = $idempotencyKey
           LIMIT 1`,
        )
        .get({
          $idempotencyKey: entry.idempotencyKey,
          $workspaceId: entry.workspaceId,
        });

      if (conflict) {
        const existing = outboxJobFromRow(conflict);
        const matches = this.existingCaptureOutboxEntryMatches(existing, entry);

        this.options.database.run('ROLLBACK');
        transactionOpen = false;

        return matches
          ? success(existing)
          : failure({
              code: 'idempotency_key_conflict',
              message: 'Outbox idempotency key already exists for this workspace.',
            });
      }

      const existingJobId = this.options.database
        .prepare<{ id: string }>(
          `SELECT id
           FROM outbox_jobs
           WHERE id = $id
           LIMIT 1`,
        )
        .get({ $id: entry.id });

      if (existingJobId) {
        this.options.database.run('ROLLBACK');
        transactionOpen = false;
        return failure({
          code: 'outbox_job_id_conflict',
          message: 'Outbox job id already exists.',
        });
      }

      for (const assetRef of entry.assetRefs) {
        const existingAssetRef = this.readAssetRef(assetRef.assetRefId);

        if (existingAssetRef && !assetRefMatches(existingAssetRef, assetRef)) {
          this.options.database.run('ROLLBACK');
          transactionOpen = false;
          return failure({
            code: 'asset_ref_conflict',
            message: 'Asset ref already exists with different metadata.',
          });
        }
      }

      const created: OutboxJob = {
        assetRefId: entry.assetRefId,
        attempt: 0,
        capture: normalizeCapturePayload(entry),
        createdAt: entry.createdAt,
        deviceId: entry.deviceId,
        id: entry.id,
        idempotencyKey: entry.idempotencyKey,
        payloadHash: entry.payloadHash,
        state: 'pending',
        updatedAt: entry.createdAt,
        workspaceId: entry.workspaceId,
        ...(entry.nextRetryAt ? { nextRetryAt: entry.nextRetryAt } : {}),
      };

      for (const assetRef of entry.assetRefs) {
        this.insertAssetRef(assetRef);
      }

      this.insertOutboxJob(created);
      this.options.database.run('COMMIT');
      transactionOpen = false;

      return success(cloneOutboxJob(created));
    } catch (error) {
      if (transactionOpen) {
        this.options.database.run('ROLLBACK');
      }

      const mapped = mapCreateOutboxConstraintError(error);

      if (mapped) {
        return failure(mapped);
      }

      throw error;
    }
  }

  async getOutboxJob(id: string): Promise<OutboxJob | null> {
    const row = this.options.database
      .prepare<OutboxJobRow>('SELECT * FROM outbox_jobs WHERE id = $id LIMIT 1')
      .get({ $id: id });

    return row ? outboxJobFromRow(row) : null;
  }

  async listOutboxJobs(filter: OutboxJobListFilter = {}): Promise<OutboxJob[]> {
    const rows =
      filter.workspaceId && filter.state
        ? this.options.database
            .prepare<OutboxJobRow>(
              `SELECT *
               FROM outbox_jobs
               WHERE workspace_id = $workspaceId AND state = $state
               ORDER BY created_at ASC, id ASC`,
            )
            .all({ $state: filter.state, $workspaceId: filter.workspaceId })
        : filter.workspaceId
          ? this.options.database
              .prepare<OutboxJobRow>(
                `SELECT *
                 FROM outbox_jobs
                 WHERE workspace_id = $workspaceId
                 ORDER BY created_at ASC, id ASC`,
              )
              .all({ $workspaceId: filter.workspaceId })
          : filter.state
            ? this.options.database
                .prepare<OutboxJobRow>(
                  `SELECT *
                   FROM outbox_jobs
                   WHERE state = $state
                   ORDER BY created_at ASC, id ASC`,
                )
                .all({ $state: filter.state })
            : this.options.database
                .prepare<OutboxJobRow>('SELECT * FROM outbox_jobs ORDER BY created_at ASC, id ASC')
                .all();

    return rows.map(outboxJobFromRow);
  }

  async updateOutboxJobState(
    id: string,
    update: OutboxJobStateUpdate,
  ): Promise<OperationalStoreResult<OutboxJob>> {
    const row = this.options.database
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
         RETURNING *`,
      )
      .get({
        $id: id,
        $nextRetryAt: update.nextRetryAt ?? null,
        $ocrResultJson: update.ocrResult ? JSON.stringify(update.ocrResult) : null,
        $serverCaptureId: update.serverCaptureId ?? null,
        $state: update.state,
        $updatedAt: update.now,
      });

    if (!row) {
      return failure(this.missingOrTerminalOutboxError(id, terminalTransitionConflict()));
    }

    return success(outboxJobFromRow(row));
  }

  async claimNextRetryableOutboxJob(
    input: ClaimRetryableOutboxJobInput,
  ): Promise<OutboxJob | null> {
    const row = this.options.database
      .prepare<OutboxJobRow>(
        `UPDATE outbox_jobs
         SET state = 'syncing',
             locked_at = $now,
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
        $now: input.now,
        $workspaceId: input.workspaceId,
      });

    return row ? outboxJobFromRow(row) : null;
  }

  async markOutboxJobTerminal(
    id: string,
    update: OutboxTerminalUpdate,
  ): Promise<OperationalStoreResult<OutboxJob>> {
    const row = this.options.database
      .prepare<OutboxJobRow>(
        `UPDATE outbox_jobs
         SET state = $state,
             updated_at = $updatedAt,
             next_retry_at = NULL,
             locked_at = NULL,
             server_capture_id = $serverCaptureId,
             last_safe_error_json = $lastSafeErrorJson,
             terminal_reason = $terminalReason
         WHERE id = $id
           AND state NOT IN ('synced', 'blocked', 'failed', 'cancelled')
         RETURNING *`,
      )
      .get({
        $id: id,
        $lastSafeErrorJson: update.lastSafeError ? JSON.stringify(update.lastSafeError) : null,
        $serverCaptureId: update.serverCaptureId ?? null,
        $state: update.state,
        $terminalReason: update.reason,
        $updatedAt: update.now,
      });

    if (!row) {
      return failure(
        this.missingOrTerminalOutboxError(id, {
          code: 'terminal_state_conflict',
          message: 'Terminal outbox jobs cannot transition to another terminal state.',
        }),
      );
    }

    return success(outboxJobFromRow(row));
  }

  async recordOutboxSafeError(
    id: string,
    input: OutboxSafeErrorInput,
  ): Promise<OperationalStoreResult<OutboxJob>> {
    const row = this.options.database
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
             last_safe_error_json = $lastSafeErrorJson,
             terminal_reason = CASE
               WHEN $retryable = 1 AND attempt + 1 < $maxAttempts THEN NULL
               ELSE $terminalReason
             END
         WHERE id = $id
           AND state NOT IN ('synced', 'blocked', 'failed', 'cancelled')
         RETURNING *`,
      )
      .get({
        $id: id,
        $lastSafeErrorJson: JSON.stringify({
          code: input.code,
          message: input.message,
          retryable: input.retryable,
        }),
        $maxAttempts: input.maxAttempts,
        $retryAt: input.retryAt ?? null,
        $retryable: input.retryable ? 1 : 0,
        $terminalReason: input.code,
        $updatedAt: input.now,
      });

    if (!row) {
      return failure(
        this.missingOrTerminalOutboxError(id, {
          code: 'terminal_state_conflict',
          message: 'Terminal outbox jobs cannot be retried.',
        }),
      );
    }

    return success(outboxJobFromRow(row));
  }

  async recoverInterruptedOutboxJob(
    input: RecoverInterruptedOutboxJobInput,
  ): Promise<OperationalStoreResult<OutboxJob>> {
    const row = this.options.database
      .prepare<OutboxJobRow>(
        `UPDATE outbox_jobs
         SET state = 'pending',
             updated_at = $updatedAt,
             next_retry_at = $nextRetryAt,
             locked_at = NULL,
             last_safe_error_json = $lastSafeErrorJson,
             terminal_reason = NULL
         WHERE id = $id
           AND state IN ('syncing', 'result_pending')
         RETURNING *`,
      )
      .get({
        $id: input.id,
        $lastSafeErrorJson: JSON.stringify(input.lastSafeError),
        $nextRetryAt: input.nextRetryAt,
        $updatedAt: input.now,
      });

    if (!row) {
      return failure(
        this.missingOrTerminalOutboxError(input.id, {
          code: 'terminal_state_conflict',
          message: 'Only interrupted outbox jobs can be recovered at startup.',
        }),
      );
    }

    return success(outboxJobFromRow(row));
  }

  async upsertAssetCacheRef(asset: AssetCacheRef): Promise<AssetCacheRef> {
    const cloned = cloneAssetRef(asset);
    this.insertAssetRef(cloned);

    return cloneAssetRef(cloned);
  }

  async getAssetCacheRef(assetRefId: string): Promise<AssetCacheRef | null> {
    const row = this.options.database
      .prepare<AssetCacheRefRow>(
        `SELECT *
         FROM asset_cache_refs
         WHERE asset_ref_id = $assetRefId
         LIMIT 1`,
      )
      .get({ $assetRefId: assetRefId });

    return row ? assetRefFromRow(row) : null;
  }

  async listAssetCacheRefs(workspaceId?: string): Promise<AssetCacheRef[]> {
    const rows = workspaceId
      ? this.options.database
          .prepare<AssetCacheRefRow>(
            `SELECT *
             FROM asset_cache_refs
             WHERE workspace_id = $workspaceId
             ORDER BY created_at ASC, asset_ref_id ASC`,
          )
          .all({ $workspaceId: workspaceId })
      : this.options.database
          .prepare<AssetCacheRefRow>(
            'SELECT * FROM asset_cache_refs ORDER BY workspace_id ASC, created_at ASC, asset_ref_id ASC',
          )
          .all();

    return rows.map(assetRefFromRow);
  }

  async updateAssetRefAvailability(
    input: UpdateAssetRefAvailabilityInput,
  ): Promise<OperationalStoreResult<AssetCacheRef>> {
    const row = this.options.database
      .prepare<AssetCacheRefRow>(
        `UPDATE asset_cache_refs
         SET availability_state = $availabilityState,
             availability_checked_at = $availabilityCheckedAt,
             availability_safe_error_json = $availabilitySafeErrorJson
         WHERE asset_ref_id = $assetRefId
         RETURNING *`,
      )
      .get({
        $assetRefId: input.assetRefId,
        $availabilityCheckedAt: input.now,
        $availabilitySafeErrorJson: input.availabilitySafeError
          ? JSON.stringify(input.availabilitySafeError)
          : null,
        $availabilityState: input.availabilityState,
      });

    if (!row) {
      return failure(notFound('asset_ref_not_found', 'Asset ref was not found.'));
    }

    return success(assetRefFromRow(row));
  }

  async deleteAssetCacheRef(assetRefId: string): Promise<boolean> {
    const result = this.options.database
      .prepare(
        `DELETE FROM asset_cache_refs
         WHERE asset_ref_id = $assetRefId`,
      )
      .run({ $assetRefId: assetRefId });

    return result.changes > 0;
  }

  async setHelperState(state: HelperRuntimeState): Promise<HelperRuntimeState> {
    const cloned = cloneHelperState(state);
    this.options.database
      .prepare(
        `INSERT INTO helper_state (id, state_json, updated_at)
         VALUES ($id, $stateJson, $updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           state_json = excluded.state_json,
           updated_at = excluded.updated_at`,
      )
      .run({
        $id: HELPER_STATE_KEY,
        $stateJson: JSON.stringify(cloned),
        $updatedAt: cloned.updatedAt,
      });

    return cloneHelperState(cloned);
  }

  async getHelperState(): Promise<HelperRuntimeState | null> {
    const row = this.options.database
      .prepare<{ state_json: string }>(
        `SELECT state_json
         FROM helper_state
         WHERE id = $id
         LIMIT 1`,
      )
      .get({ $id: HELPER_STATE_KEY });

    return row ? cloneHelperState(parseJson<HelperRuntimeState>(row.state_json)) : null;
  }

  async setPolicyCache(entry: PolicyCacheEntry): Promise<PolicyCacheEntry> {
    const cloned = clonePolicyCache(entry);
    this.options.database
      .prepare(
        `INSERT INTO policy_cache (
          workspace_id,
          policy_version,
          actions_json,
          fetched_at,
          ttl_seconds
        ) VALUES (
          $workspaceId,
          $policyVersion,
          $actionsJson,
          $fetchedAt,
          $ttlSeconds
        )
        ON CONFLICT(workspace_id) DO UPDATE SET
          policy_version = excluded.policy_version,
          actions_json = excluded.actions_json,
          fetched_at = excluded.fetched_at,
          ttl_seconds = excluded.ttl_seconds`,
      )
      .run({
        $actionsJson: JSON.stringify(cloned.actions),
        $fetchedAt: cloned.fetchedAt,
        $policyVersion: cloned.policyVersion,
        $ttlSeconds: cloned.ttlSeconds,
        $workspaceId: cloned.workspaceId,
      });

    return clonePolicyCache(cloned);
  }

  async getPolicyCache(
    workspaceId: string,
    options: PolicyCacheReadOptions,
  ): Promise<PolicyCacheRead | null> {
    const row = this.options.database
      .prepare<PolicyCacheRow>(
        `SELECT *
         FROM policy_cache
         WHERE workspace_id = $workspaceId
         LIMIT 1`,
      )
      .get({ $workspaceId: workspaceId });

    if (!row) {
      return null;
    }

    const entry = policyCacheFromRow(row);
    return {
      ...entry,
      expired: isExpired(entry.fetchedAt, entry.ttlSeconds, options.now),
    };
  }

  async setSyncCursor(cursor: SyncCursor): Promise<SyncCursor> {
    const cloned = cloneSyncCursor(cursor);
    this.options.database
      .prepare(
        `INSERT INTO sync_cursors (
          workspace_id,
          kind,
          cursor,
          etag,
          updated_at
        ) VALUES (
          $workspaceId,
          $kind,
          $cursor,
          $etag,
          $updatedAt
        )
        ON CONFLICT(workspace_id, kind) DO UPDATE SET
          cursor = excluded.cursor,
          etag = excluded.etag,
          updated_at = excluded.updated_at`,
      )
      .run({
        $cursor: cloned.cursor,
        $etag: cloned.etag ?? null,
        $kind: cloned.kind,
        $updatedAt: cloned.updatedAt,
        $workspaceId: cloned.workspaceId,
      });

    return cloneSyncCursor(cloned);
  }

  async getSyncCursor(workspaceId: string, kind: SyncCursorKind): Promise<SyncCursor | null> {
    const row = this.options.database
      .prepare<SyncCursorRow>(
        `SELECT *
         FROM sync_cursors
         WHERE workspace_id = $workspaceId AND kind = $kind
         LIMIT 1`,
      )
      .get({ $kind: kind, $workspaceId: workspaceId });

    return row ? syncCursorFromRow(row) : null;
  }

  async setSettingsCache(settings: SettingsCache): Promise<SettingsCache> {
    const cloned = cloneSettingsCache(settings);
    this.options.database
      .prepare(
        `INSERT INTO settings_cache (
          workspace_id,
          device_id,
          capture_enabled,
          fetched_at,
          server_capabilities_json
        ) VALUES (
          $workspaceId,
          $deviceId,
          $captureEnabled,
          $fetchedAt,
          $serverCapabilitiesJson
        )
        ON CONFLICT(workspace_id) DO UPDATE SET
          device_id = excluded.device_id,
          capture_enabled = excluded.capture_enabled,
          fetched_at = excluded.fetched_at,
          server_capabilities_json = excluded.server_capabilities_json`,
      )
      .run({
        $captureEnabled: cloned.captureEnabled ? 1 : 0,
        $deviceId: cloned.deviceId,
        $fetchedAt: cloned.fetchedAt,
        $serverCapabilitiesJson: JSON.stringify(cloned.serverCapabilities),
        $workspaceId: cloned.workspaceId,
      });

    return cloneSettingsCache(cloned);
  }

  async getSettingsCache(workspaceId: string): Promise<SettingsCache | null> {
    const row = this.options.database
      .prepare<SettingsCacheRow>(
        `SELECT *
         FROM settings_cache
         WHERE workspace_id = $workspaceId
         LIMIT 1`,
      )
      .get({ $workspaceId: workspaceId });

    return row ? settingsCacheFromRow(row) : null;
  }

  async getBackpressureSnapshot(workspaceId: string): Promise<OperationalStoreSnapshot> {
    const jobRow = this.options.database
      .prepare<{ queued_jobs: number; max_attempt: number | null }>(
        `SELECT
           SUM(CASE WHEN state NOT IN ('synced', 'blocked', 'failed', 'cancelled') THEN 1 ELSE 0 END)
             AS queued_jobs,
           MAX(attempt) AS max_attempt
         FROM outbox_jobs
         WHERE workspace_id = $workspaceId`,
      )
      .get({ $workspaceId: workspaceId });
    const assetRow = this.options.database
      .prepare<{ asset_bytes: number | null }>(
        `SELECT SUM(size_bytes) AS asset_bytes
         FROM asset_cache_refs
         WHERE workspace_id = $workspaceId AND cleanup_state != 'cleaned'`,
      )
      .get({ $workspaceId: workspaceId });

    return {
      assetBytes: assetRow?.asset_bytes ?? 0,
      maxAttempt: jobRow?.max_attempt ?? 0,
      queuedJobs: jobRow?.queued_jobs ?? 0,
    };
  }

  async clearWorkspaceCache(workspaceId: string): Promise<void> {
    this.options.database.run('DELETE FROM outbox_jobs WHERE workspace_id = $workspaceId', {
      $workspaceId: workspaceId,
    });
    this.options.database.run('DELETE FROM asset_cache_refs WHERE workspace_id = $workspaceId', {
      $workspaceId: workspaceId,
    });
    this.options.database.run('DELETE FROM policy_cache WHERE workspace_id = $workspaceId', {
      $workspaceId: workspaceId,
    });
    this.options.database.run('DELETE FROM sync_cursors WHERE workspace_id = $workspaceId', {
      $workspaceId: workspaceId,
    });
    this.options.database.run('DELETE FROM settings_cache WHERE workspace_id = $workspaceId', {
      $workspaceId: workspaceId,
    });
  }

  async clearSignOutCache(): Promise<void> {
    this.options.database.run('DELETE FROM outbox_jobs');
    this.options.database.run('DELETE FROM asset_cache_refs');
    this.options.database.run('DELETE FROM policy_cache');
    this.options.database.run('DELETE FROM sync_cursors');
    this.options.database.run('DELETE FROM settings_cache');
    this.options.database.run('DELETE FROM helper_state');
  }

  private missingOrTerminalOutboxError(id: string, terminalError: OperationalStoreError) {
    const existing = this.options.database
      .prepare<{ state: OutboxJobState }>(
        `SELECT state
         FROM outbox_jobs
         WHERE id = $id
         LIMIT 1`,
      )
      .get({ $id: id });

    if (!existing) {
      return notFound('outbox_job_not_found', 'Outbox job was not found.');
    }

    if (isTerminalOutboxState(existing.state)) {
      return terminalError;
    }

    return {
      code: 'terminal_state_conflict',
      message: 'Outbox job state changed before the update could be applied.',
    } satisfies OperationalStoreError;
  }

  private existingCaptureOutboxEntryMatches(
    existingJob: OutboxJob,
    entry: CaptureOutboxEntryCreateInput,
  ): boolean {
    if (
      existingJob.assetRefId !== entry.assetRefId ||
      existingJob.payloadHash !== entry.payloadHash ||
      !capturePayloadMatches(existingJob.capture, normalizeCapturePayload(entry))
    ) {
      return false;
    }

    return entry.assetRefs.every((assetRef) => {
      const existingAssetRef = this.readAssetRef(assetRef.assetRefId);
      return existingAssetRef ? assetRefMatches(existingAssetRef, assetRef) : false;
    });
  }

  private readAssetRef(assetRefId: string): AssetCacheRef | null {
    const row = this.options.database
      .prepare<AssetCacheRefRow>(
        `SELECT *
         FROM asset_cache_refs
         WHERE asset_ref_id = $assetRefId
         LIMIT 1`,
      )
      .get({ $assetRefId: assetRefId });

    return row ? assetRefFromRow(row) : null;
  }

  private insertAssetRef(asset: AssetCacheRef): void {
    const cloned = cloneAssetRef(asset);
    this.options.database
      .prepare(
        `INSERT INTO asset_cache_refs (
          asset_ref_id,
          workspace_id,
          role,
          hash,
          mime_type,
          size_bytes,
          cleanup_state,
          availability_state,
          availability_checked_at,
          created_at,
          local_access_key,
          availability_safe_error_json,
          content_address
        ) VALUES (
          $assetRefId,
          $workspaceId,
          $role,
          $hash,
          $mimeType,
          $sizeBytes,
          $cleanupState,
          $availabilityState,
          $availabilityCheckedAt,
          $createdAt,
          $localAccessKey,
          $availabilitySafeErrorJson,
          $contentAddress
        )
        ON CONFLICT(asset_ref_id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          role = excluded.role,
          hash = excluded.hash,
          mime_type = excluded.mime_type,
          size_bytes = excluded.size_bytes,
          cleanup_state = excluded.cleanup_state,
          availability_state = excluded.availability_state,
          availability_checked_at = excluded.availability_checked_at,
          created_at = excluded.created_at,
          local_access_key = excluded.local_access_key,
          availability_safe_error_json = excluded.availability_safe_error_json,
          content_address = excluded.content_address`,
      )
      .run(assetParameters(cloned));
  }

  private insertOutboxJob(job: OutboxJob): void {
    this.options.database
      .prepare(
        `INSERT INTO outbox_jobs (
          id,
          workspace_id,
          device_id,
          asset_ref_id,
          idempotency_key,
          payload_hash,
          capture_json,
          state,
          attempt,
          created_at,
          updated_at,
          next_retry_at
        ) VALUES (
          $id,
          $workspaceId,
          $deviceId,
          $assetRefId,
          $idempotencyKey,
          $payloadHash,
          $captureJson,
          $state,
          $attempt,
          $createdAt,
          $updatedAt,
          $nextRetryAt
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
  server_capture_id?: string | null;
  ocr_result_json?: string | null;
  last_safe_error_json?: string | null;
  terminal_reason?: string | null;
};

type AssetCacheRefRow = SqliteRow & {
  asset_ref_id: string;
  workspace_id: string;
  role: AssetCacheRef['role'];
  hash: string;
  mime_type: string;
  size_bytes: number;
  cleanup_state: AssetCacheRef['cleanupState'];
  availability_state: AssetCacheRef['availabilityState'];
  availability_checked_at?: string | null;
  created_at: string;
  local_access_key: string;
  availability_safe_error_json?: string | null;
  content_address?: string | null;
};

type PolicyCacheRow = SqliteRow & {
  workspace_id: string;
  policy_version: string;
  actions_json: string;
  fetched_at: string;
  ttl_seconds: number;
};

type SyncCursorRow = SqliteRow & {
  workspace_id: string;
  kind: SyncCursorKind;
  cursor: string;
  etag?: string | null;
  updated_at: string;
};

type SettingsCacheRow = SqliteRow & {
  workspace_id: string;
  device_id: string;
  capture_enabled: number;
  fetched_at: string;
  server_capabilities_json: string;
};

function buildOutboxJobsTable(tableName: string, ifNotExists: boolean): string {
  return `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${tableName} (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    asset_ref_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    capture_json TEXT NOT NULL CHECK (json_valid(capture_json)),
    state TEXT NOT NULL CHECK (
      state IN ('pending', 'syncing', 'result_pending', 'synced', 'blocked', 'failed', 'cancelled')
    ),
    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    next_retry_at TEXT,
    locked_at TEXT,
    server_capture_id TEXT,
    ocr_result_json TEXT CHECK (
      ocr_result_json IS NULL OR json_valid(ocr_result_json)
    ),
    last_safe_error_json TEXT CHECK (
      last_safe_error_json IS NULL OR json_valid(last_safe_error_json)
    ),
    terminal_reason TEXT,
    UNIQUE(workspace_id, idempotency_key)
  )`;
}

const OUTBOX_JOBS_INDEX_STATEMENT = `CREATE INDEX IF NOT EXISTS idx_outbox_jobs_workspace_state_retry
    ON outbox_jobs(workspace_id, state, next_retry_at, created_at)`;

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`,
  buildOutboxJobsTable('outbox_jobs', true),
  OUTBOX_JOBS_INDEX_STATEMENT,
  `CREATE TABLE IF NOT EXISTS asset_cache_refs (
    asset_ref_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (
      role IN ('capture_original', 'capture_thumbnail', 'ocr_input', 'derived_asset')
    ),
    hash TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    cleanup_state TEXT NOT NULL CHECK (
      cleanup_state IN ('retained', 'cleanup_pending', 'cleaned', 'cleanup_failed')
    ),
    availability_state TEXT NOT NULL DEFAULT 'available' CHECK (
      availability_state IN ('available', 'missing', 'unreadable')
    ),
    availability_checked_at TEXT,
    created_at TEXT NOT NULL,
    local_access_key TEXT NOT NULL,
    availability_safe_error_json TEXT CHECK (
      availability_safe_error_json IS NULL OR json_valid(availability_safe_error_json)
    ),
    content_address TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_asset_cache_refs_workspace
    ON asset_cache_refs(workspace_id, cleanup_state, created_at)`,
  `CREATE TABLE IF NOT EXISTS helper_state (
    id TEXT PRIMARY KEY,
    state_json TEXT NOT NULL CHECK (json_valid(state_json)),
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS policy_cache (
    workspace_id TEXT PRIMARY KEY,
    policy_version TEXT NOT NULL,
    actions_json TEXT NOT NULL CHECK (json_valid(actions_json)),
    fetched_at TEXT NOT NULL,
    ttl_seconds INTEGER NOT NULL CHECK (ttl_seconds >= 0)
  )`,
  `CREATE TABLE IF NOT EXISTS sync_cursors (
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('timeline', 'search', 'settings', 'capabilities')),
    cursor TEXT NOT NULL,
    etag TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id, kind)
  )`,
  `CREATE TABLE IF NOT EXISTS settings_cache (
    workspace_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    capture_enabled INTEGER NOT NULL CHECK (capture_enabled IN (0, 1)),
    fetched_at TEXT NOT NULL,
    server_capabilities_json TEXT NOT NULL CHECK (json_valid(server_capabilities_json))
  )`,
];

function assetParameters(asset: AssetCacheRef): Record<string, string | number | null> {
  return {
    $assetRefId: asset.assetRefId,
    $availabilityCheckedAt: asset.availabilityCheckedAt ?? null,
    $availabilitySafeErrorJson: asset.availabilitySafeError
      ? JSON.stringify(asset.availabilitySafeError)
      : null,
    $availabilityState: asset.availabilityState,
    $cleanupState: asset.cleanupState,
    $contentAddress: asset.contentAddress ?? null,
    $createdAt: asset.createdAt,
    $hash: asset.hash,
    $localAccessKey: asset.localAccessKey,
    $mimeType: asset.mimeType,
    $role: asset.role,
    $sizeBytes: asset.sizeBytes,
    $workspaceId: asset.workspaceId,
  };
}

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
    ...(row.next_retry_at ? { nextRetryAt: row.next_retry_at } : {}),
    ...(row.server_capture_id ? { serverCaptureId: row.server_capture_id } : {}),
    ...(row.ocr_result_json ? { ocrResult: parseJson<StoredOcrResult>(row.ocr_result_json) } : {}),
    ...(row.terminal_reason ? { terminalReason: row.terminal_reason } : {}),
  });
}

function assetRefFromRow(row: AssetCacheRefRow): AssetCacheRef {
  return cloneAssetRef({
    assetRefId: row.asset_ref_id,
    availabilityState: row.availability_state,
    cleanupState: row.cleanup_state,
    createdAt: row.created_at,
    hash: row.hash,
    localAccessKey: row.local_access_key,
    mimeType: row.mime_type,
    role: row.role,
    sizeBytes: row.size_bytes,
    workspaceId: row.workspace_id,
    ...(row.availability_checked_at ? { availabilityCheckedAt: row.availability_checked_at } : {}),
    ...(row.content_address ? { contentAddress: row.content_address } : {}),
    ...(row.availability_safe_error_json
      ? {
          availabilitySafeError: parseJson<AssetCacheRef['availabilitySafeError']>(
            row.availability_safe_error_json,
          ),
        }
      : {}),
  });
}

function policyCacheFromRow(row: PolicyCacheRow): PolicyCacheEntry {
  return clonePolicyCache({
    actions: parseJson<PolicyCacheEntry['actions']>(row.actions_json),
    fetchedAt: row.fetched_at,
    policyVersion: row.policy_version,
    ttlSeconds: row.ttl_seconds,
    workspaceId: row.workspace_id,
  });
}

function syncCursorFromRow(row: SyncCursorRow): SyncCursor {
  return cloneSyncCursor({
    cursor: row.cursor,
    kind: row.kind,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
    ...(row.etag ? { etag: row.etag } : {}),
  });
}

function settingsCacheFromRow(row: SettingsCacheRow): SettingsCache {
  return cloneSettingsCache({
    captureEnabled: row.capture_enabled === 1,
    deviceId: row.device_id,
    fetchedAt: row.fetched_at,
    serverCapabilities: parseJson<SettingsCache['serverCapabilities']>(
      row.server_capabilities_json,
    ),
    workspaceId: row.workspace_id,
  });
}

function isTerminalOutboxState(state: OutboxJobState): state is OutboxTerminalState {
  return TERMINAL_OUTBOX_STATES.has(state);
}

function terminalTransitionConflict(): OperationalStoreError {
  return {
    code: 'terminal_state_conflict',
    message: 'Terminal outbox jobs cannot transition to another state.',
  };
}

function notFound(code: OperationalStoreError['code'], message: string): OperationalStoreError {
  return {
    code,
    message,
  };
}

function success<T>(value: T): OperationalStoreResult<T> {
  return {
    ok: true,
    value,
  };
}

function failure<T>(error: OperationalStoreError): OperationalStoreResult<T> {
  return {
    error,
    ok: false,
  };
}

function isExpired(fetchedAt: string, ttlSeconds: number, now: string): boolean {
  return Date.parse(now) > Date.parse(fetchedAt) + ttlSeconds * 1000;
}

function normalizeCapturePayload(job: OutboxJobCreateInput): OutboxJob['capture'] {
  return {
    appName: job.capture?.appName ?? 'Recapsy Desktop',
    capturedAt: job.capture?.capturedAt ?? job.createdAt,
    captureType: job.capture?.captureType ?? 'screen',
    observedAt: job.capture?.observedAt ?? job.createdAt,
    privacyDecision: {
      action: job.capture?.privacyDecision?.action ?? 'allow',
      decidedAt:
        job.capture?.privacyDecision?.decidedAt ??
        job.capture?.observedAt ??
        job.capture?.capturedAt ??
        job.createdAt,
      policyVersion: job.capture?.privacyDecision?.policyVersion ?? 'desktop-default',
      reasons: [...(job.capture?.privacyDecision?.reasons ?? [])],
    },
    ...(job.capture?.bundleId ? { bundleId: job.capture.bundleId } : {}),
    ...(job.capture?.contextConfidence ? { contextConfidence: job.capture.contextConfidence } : {}),
    ...(job.capture?.contextFingerprint
      ? { contextFingerprint: job.capture.contextFingerprint }
      : {}),
    ...(job.capture?.documentPathCandidate
      ? { documentPathCandidate: { ...job.capture.documentPathCandidate } }
      : {}),
    ...(job.capture?.localEventId ? { localEventId: job.capture.localEventId } : {}),
    ...(job.capture?.metadata ? { metadata: { ...job.capture.metadata } } : {}),
    ...(job.capture?.urlCandidate ? { urlCandidate: { ...job.capture.urlCandidate } } : {}),
    ...(job.capture?.userId ? { userId: job.capture.userId } : {}),
    ...(job.capture?.windowTitleCandidate
      ? { windowTitleCandidate: { ...job.capture.windowTitleCandidate } }
      : {}),
  };
}

function cloneOutboxJob(job: OutboxJob): OutboxJob {
  return {
    ...job,
    capture: cloneCapturePayload(job.capture),
    ...(job.lastSafeError ? { lastSafeError: { ...job.lastSafeError } } : {}),
  };
}

function cloneCapturePayload(capture: OutboxJob['capture']): OutboxJob['capture'] {
  return {
    ...capture,
    privacyDecision: {
      ...capture.privacyDecision,
      reasons: [...capture.privacyDecision.reasons],
    },
    ...(capture.documentPathCandidate
      ? { documentPathCandidate: { ...capture.documentPathCandidate } }
      : {}),
    ...(capture.metadata ? { metadata: { ...capture.metadata } } : {}),
    ...(capture.urlCandidate ? { urlCandidate: { ...capture.urlCandidate } } : {}),
    ...(capture.windowTitleCandidate
      ? { windowTitleCandidate: { ...capture.windowTitleCandidate } }
      : {}),
  };
}

function cloneAssetRef(asset: AssetCacheRef): AssetCacheRef {
  return { ...asset };
}

function capturePayloadMatches(left: OutboxJob['capture'], right: OutboxJob['capture']): boolean {
  return JSON.stringify(cloneCapturePayload(left)) === JSON.stringify(cloneCapturePayload(right));
}

function assetRefMatches(left: AssetCacheRef, right: AssetCacheRef): boolean {
  return JSON.stringify(cloneAssetRef(left)) === JSON.stringify(cloneAssetRef(right));
}

function cloneHelperState(state: HelperRuntimeState): HelperRuntimeState {
  return {
    ...state,
    ...(state.lastSafeError ? { lastSafeError: { ...state.lastSafeError } } : {}),
    permissions: {
      ...state.permissions,
    },
  };
}

function clonePolicyCache(entry: PolicyCacheEntry): PolicyCacheEntry {
  return {
    ...entry,
    actions: [...entry.actions],
  };
}

function cloneSyncCursor(cursor: SyncCursor): SyncCursor {
  return { ...cursor };
}

function cloneSettingsCache(settings: SettingsCache): SettingsCache {
  return {
    ...settings,
    serverCapabilities: {
      ...settings.serverCapabilities,
    },
  };
}

function parseJson<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new StorageCorruptionError();
  }
}

class StorageCorruptionError extends Error {
  readonly code = 'storage_corruption';

  constructor() {
    super('Local operational store contains invalid JSON.');
  }
}

function mapCreateOutboxConstraintError(error: unknown): OperationalStoreError | null {
  if (!isSqliteConstraintError(error)) {
    return null;
  }

  const text = sqliteErrorText(error);

  if (text.includes('outbox_jobs.id')) {
    return {
      code: 'outbox_job_id_conflict',
      message: 'Outbox job id already exists.',
    };
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

function isSqliteConstraintError(error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }

  return sqliteErrorText(error).includes('constraint');
}

function sqliteErrorText(error: Error): string {
  const fields = [error.name, error.message, 'code' in error ? String(error.code) : ''];

  return fields.join(' ').toLowerCase();
}
