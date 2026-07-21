import type { SqliteDatabase } from './driver';

const SCHEMA_VERSION = 10;

export function migrateSqliteStore(database: SqliteDatabase): void {
  database.run('PRAGMA foreign_keys = ON');
  database.run('PRAGMA journal_mode = WAL');
  database.run('PRAGMA busy_timeout = 5000');

  for (const statement of schemaStatements) {
    database.run(statement);
  }

  ensureAssetAvailabilityColumns(database);
  ensureAssetCleanupColumns(database);
  migrateOutboxJobsToV2(database);
  ensureOutboxLeaseColumns(database);
  migratePolicyCacheToWorkspaceDevice(database);
  ensurePolicyCacheDeliveryCapacityColumn(database);
  ensureOperationalStoreStatistics(database);

  database.run(
    `INSERT OR IGNORE INTO schema_migrations (version, applied_at)
     VALUES ($version, $appliedAt)`,
    {
      $appliedAt: new Date().toISOString(),
      $version: SCHEMA_VERSION,
    },
  );
}

function ensureOperationalStoreStatistics(database: SqliteDatabase): void {
  database.run(
    `CREATE TABLE IF NOT EXISTS operational_store_statistics (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      queued_jobs INTEGER NOT NULL CHECK (queued_jobs >= 0),
      retrying_jobs INTEGER NOT NULL CHECK (retrying_jobs >= 0),
      asset_bytes INTEGER NOT NULL CHECK (asset_bytes >= 0)
    )`,
  );
  for (const trigger of operationalStoreStatisticTriggers) {
    database.run(`DROP TRIGGER IF EXISTS ${trigger.name}`);
  }
  database.run(
    `INSERT INTO operational_store_statistics (
      id,
      queued_jobs,
      retrying_jobs,
      asset_bytes
    ) VALUES (
      1,
      (
        SELECT COUNT(*)
        FROM outbox_jobs
        WHERE state NOT IN ('synced', 'blocked', 'failed', 'cancelled')
      ),
      (
        SELECT COUNT(*)
        FROM outbox_jobs
        WHERE state = 'pending' AND next_retry_at IS NOT NULL
      ),
      (
        SELECT COALESCE(SUM(size_bytes), 0)
        FROM asset_cache_refs
        WHERE cleanup_state != 'cleaned'
      )
    )
    ON CONFLICT(id) DO UPDATE SET
      queued_jobs = excluded.queued_jobs,
      retrying_jobs = excluded.retrying_jobs,
      asset_bytes = excluded.asset_bytes`,
  );
  for (const trigger of operationalStoreStatisticTriggers) {
    database.run(trigger.statement);
  }
}

function ensureOutboxLeaseColumns(database: SqliteDatabase): void {
  const columns = new Set(
    database
      .prepare<{ name: string }>('PRAGMA table_info(outbox_jobs)')
      .all()
      .map((column) => column.name),
  );
  if (!columns.has('lease_token')) {
    database.run('ALTER TABLE outbox_jobs ADD COLUMN lease_token TEXT');
  }
  if (!columns.has('lease_expires_at')) {
    database.run('ALTER TABLE outbox_jobs ADD COLUMN lease_expires_at TEXT');
  }
}

function migratePolicyCacheToWorkspaceDevice(database: SqliteDatabase): void {
  const columns = new Set(
    database
      .prepare<{ name: string }>('PRAGMA table_info(policy_cache)')
      .all()
      .map((column) => column.name),
  );

  if (columns.has('device_id') && columns.has('policy_json') && columns.has('policy_snapshot_id')) {
    return;
  }

  let transactionOpen = false;
  try {
    database.run('BEGIN IMMEDIATE');
    transactionOpen = true;
    database.run(buildPolicyCacheTable('policy_cache__v3', false));
    database.run(
      `INSERT INTO policy_cache__v3 (
        workspace_id,
        device_id,
        policy_snapshot_id,
        policy_version,
        policy_json,
        fetched_at,
        ttl_seconds
      )
      SELECT
        workspace_id,
        'legacy-device',
        'legacy:' || policy_version,
        policy_version,
        json_object(
          'paused', false,
          'defaultAction', 'allow',
          'axTextUploadEnabled', false,
          'rules', json('[]')
        ),
        fetched_at,
        ttl_seconds
      FROM policy_cache`,
    );
    database.run('DROP TABLE policy_cache');
    database.run('ALTER TABLE policy_cache__v3 RENAME TO policy_cache');
    database.run('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) database.run('ROLLBACK');
    throw error;
  }
}

function ensurePolicyCacheDeliveryCapacityColumn(database: SqliteDatabase): void {
  const columns = new Set(
    database
      .prepare<{ name: string }>('PRAGMA table_info(policy_cache)')
      .all()
      .map((column) => column.name),
  );

  if (!columns.has('max_concurrent_ocr')) {
    database.run(
      `ALTER TABLE policy_cache
       ADD COLUMN max_concurrent_ocr INTEGER NOT NULL DEFAULT 1
       CHECK (max_concurrent_ocr BETWEEN 1 AND 32)`,
    );
  }
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

function ensureAssetCleanupColumns(database: SqliteDatabase): void {
  const columns = new Set(
    database
      .prepare<{ name: string }>('PRAGMA table_info(asset_cache_refs)')
      .all()
      .map((column) => column.name),
  );

  if (!columns.has('cleanup_updated_at')) {
    database.run('ALTER TABLE asset_cache_refs ADD COLUMN cleanup_updated_at TEXT');
  }
  if (!columns.has('cleanup_safe_error_json')) {
    database.run(
      `ALTER TABLE asset_cache_refs
       ADD COLUMN cleanup_safe_error_json TEXT
       CHECK (cleanup_safe_error_json IS NULL OR json_valid(cleanup_safe_error_json))`,
    );
  }
}

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
    lease_token TEXT,
    lease_expires_at TEXT,
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

const operationalStoreStatisticTriggers = [
  {
    name: 'outbox_jobs_statistics_after_insert',
    statement: `CREATE TRIGGER outbox_jobs_statistics_after_insert
      AFTER INSERT ON outbox_jobs
      BEGIN
        UPDATE operational_store_statistics
        SET
          queued_jobs = queued_jobs + CASE
            WHEN NEW.state NOT IN ('synced', 'blocked', 'failed', 'cancelled') THEN 1
            ELSE 0
          END,
          retrying_jobs = retrying_jobs + CASE
            WHEN NEW.state = 'pending' AND NEW.next_retry_at IS NOT NULL THEN 1
            ELSE 0
          END
        WHERE id = 1;
      END`,
  },
  {
    name: 'outbox_jobs_statistics_after_update',
    statement: `CREATE TRIGGER outbox_jobs_statistics_after_update
      AFTER UPDATE OF state, next_retry_at ON outbox_jobs
      BEGIN
        UPDATE operational_store_statistics
        SET
          queued_jobs = queued_jobs
            + CASE WHEN NEW.state NOT IN ('synced', 'blocked', 'failed', 'cancelled') THEN 1 ELSE 0 END
            - CASE WHEN OLD.state NOT IN ('synced', 'blocked', 'failed', 'cancelled') THEN 1 ELSE 0 END,
          retrying_jobs = retrying_jobs
            + CASE WHEN NEW.state = 'pending' AND NEW.next_retry_at IS NOT NULL THEN 1 ELSE 0 END
            - CASE WHEN OLD.state = 'pending' AND OLD.next_retry_at IS NOT NULL THEN 1 ELSE 0 END
        WHERE id = 1;
      END`,
  },
  {
    name: 'outbox_jobs_statistics_after_delete',
    statement: `CREATE TRIGGER outbox_jobs_statistics_after_delete
      AFTER DELETE ON outbox_jobs
      BEGIN
        UPDATE operational_store_statistics
        SET
          queued_jobs = queued_jobs - CASE
            WHEN OLD.state NOT IN ('synced', 'blocked', 'failed', 'cancelled') THEN 1
            ELSE 0
          END,
          retrying_jobs = retrying_jobs - CASE
            WHEN OLD.state = 'pending' AND OLD.next_retry_at IS NOT NULL THEN 1
            ELSE 0
          END
        WHERE id = 1;
      END`,
  },
  {
    name: 'asset_cache_refs_statistics_after_insert',
    statement: `CREATE TRIGGER asset_cache_refs_statistics_after_insert
      AFTER INSERT ON asset_cache_refs
      BEGIN
        UPDATE operational_store_statistics
        SET asset_bytes = asset_bytes + CASE
          WHEN NEW.cleanup_state != 'cleaned' THEN NEW.size_bytes
          ELSE 0
        END
        WHERE id = 1;
      END`,
  },
  {
    name: 'asset_cache_refs_statistics_after_update',
    statement: `CREATE TRIGGER asset_cache_refs_statistics_after_update
      AFTER UPDATE OF size_bytes, cleanup_state ON asset_cache_refs
      BEGIN
        UPDATE operational_store_statistics
        SET asset_bytes = asset_bytes
          + CASE WHEN NEW.cleanup_state != 'cleaned' THEN NEW.size_bytes ELSE 0 END
          - CASE WHEN OLD.cleanup_state != 'cleaned' THEN OLD.size_bytes ELSE 0 END
        WHERE id = 1;
      END`,
  },
  {
    name: 'asset_cache_refs_statistics_after_delete',
    statement: `CREATE TRIGGER asset_cache_refs_statistics_after_delete
      AFTER DELETE ON asset_cache_refs
      BEGIN
        UPDATE operational_store_statistics
        SET asset_bytes = asset_bytes - CASE
          WHEN OLD.cleanup_state != 'cleaned' THEN OLD.size_bytes
          ELSE 0
        END
        WHERE id = 1;
      END`,
  },
] as const;

function buildPolicyCacheTable(tableName: string, ifNotExists: boolean): string {
  return `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${tableName} (
    workspace_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    policy_snapshot_id TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
    fetched_at TEXT NOT NULL,
    ttl_seconds INTEGER NOT NULL CHECK (ttl_seconds >= 0),
    max_concurrent_ocr INTEGER NOT NULL DEFAULT 1 CHECK (max_concurrent_ocr BETWEEN 1 AND 32),
    PRIMARY KEY(workspace_id, device_id)
  )`;
}

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS operational_health_probe (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    generation INTEGER NOT NULL CHECK (generation >= 1),
    updated_at TEXT NOT NULL
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
    cleanup_updated_at TEXT,
    cleanup_safe_error_json TEXT CHECK (
      cleanup_safe_error_json IS NULL OR json_valid(cleanup_safe_error_json)
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
  buildPolicyCacheTable('policy_cache', true),
  `CREATE TABLE IF NOT EXISTS local_capture_policy_rules (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind = 'bundle_id'),
    pattern TEXT NOT NULL UNIQUE,
    action TEXT NOT NULL CHECK (action = 'block_capture'),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_local_capture_policy_rules_enabled_pattern
    ON local_capture_policy_rules(enabled, pattern)`,
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
  `CREATE TABLE IF NOT EXISTS capture_coverage_segments (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    coverage_state TEXT NOT NULL CHECK (
      coverage_state IN (
        'static', 'blank', 'low_information', 'no_window',
        'privacy_withheld', 'secure_field', 'private_context', 'paused'
      )
    ),
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    tick_count INTEGER NOT NULL CHECK (tick_count > 0),
    interval_ms INTEGER NOT NULL CHECK (interval_ms > 0),
    close_reason TEXT NOT NULL CHECK (
      close_reason IN (
        'frame_captured', 'state_changed', 'cadence_gap',
        'paused', 'helper_exit', 'inferred_on_recovery'
      )
    ),
    sync_state TEXT NOT NULL DEFAULT 'pending' CHECK (sync_state IN ('pending', 'synced')),
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_capture_coverage_segments_pending
    ON capture_coverage_segments(workspace_id, sync_state, created_at)`,
  // One row per device. `open_coverage_*` mirrors the still-growing run's tail
  // (cleared once it closes into `capture_coverage_segments`) so the read
  // model can see it without waiting for a close, and so a crash without a
  // graceful `helper_exit` can be recovered from `last_alive_at` at startup
  // (see `recoverHangingCoverageSegment` in `storage/sqlite/coverage.ts`).
  `CREATE TABLE IF NOT EXISTS device_capture_liveness (
    workspace_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    last_alive_at TEXT NOT NULL,
    desired_state TEXT NOT NULL CHECK (desired_state IN ('running', 'paused', 'stopped')),
    open_coverage_state TEXT CHECK (
      open_coverage_state IS NULL OR open_coverage_state IN (
        'static', 'blank', 'low_information', 'no_window',
        'privacy_withheld', 'secure_field', 'private_context', 'paused'
      )
    ),
    open_coverage_started_at TEXT,
    open_coverage_tick_count INTEGER CHECK (
      open_coverage_tick_count IS NULL OR open_coverage_tick_count > 0
    ),
    open_coverage_interval_ms INTEGER CHECK (
      open_coverage_interval_ms IS NULL OR open_coverage_interval_ms > 0
    ),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, device_id)
  )`,
];
