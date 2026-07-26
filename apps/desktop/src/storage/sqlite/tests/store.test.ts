import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSyncQueueSummary } from '../../../sync/index';
import { recoverSyncQueue } from '../../../sync/index';
import {
  type AssetCacheRef,
  type OutboxJobCreateInput,
  type StoredOcrResult,
  evaluateOperationalStoreBackpressure,
  toRendererSafeAssetRef,
} from '../../index';
import { reconcileActiveAssetRefs } from '../../reconciliation';
import { createBunSqliteDatabase } from '../bun';
import type { SqliteDatabase, SqliteRow, SqliteStatement } from '../driver';
import { migrateSqliteStore } from '../migrations';
import { createSqliteStore } from '../store';

const now = '2026-07-06T00:00:00.000Z';
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe('SQLite operational store', () => {
  it('commits a bounded singleton operational write probe in the primary database', async () => {
    const { database, store } = await createTempStoreWithDatabase();

    await store.verifyOperationalWrite();
    await store.verifyOperationalWrite();

    expect(
      database
        .prepare<{ generation: number; id: number }>(
          'SELECT id, generation FROM operational_health_probe',
        )
        .get(),
    ).toEqual({ generation: 2, id: 1 });
  });

  it('rolls back an operational write probe when commit fails', async () => {
    const database = createBunSqliteDatabase(tempDatabasePath());
    const healthyStore = createSqliteStore({ database });
    await healthyStore.initialize();
    await healthyStore.verifyOperationalWrite();
    const failingStore = createSqliteStore({
      database: createFailingSqliteDatabase(database, (sql) => sql === 'COMMIT'),
    });

    await expect(failingStore.verifyOperationalWrite()).rejects.toThrow(
      'operational_write_verification_failed',
    );

    expect(
      database
        .prepare<{ generation: number }>(
          'SELECT generation FROM operational_health_probe WHERE id = 1',
        )
        .get(),
    ).toEqual({ generation: 1 });
    expect(() => database.run('BEGIN IMMEDIATE')).not.toThrow();
    database.run('ROLLBACK');
  });

  it('rolls back when the operational probe write itself fails', async () => {
    const database = createBunSqliteDatabase(tempDatabasePath());
    const healthyStore = createSqliteStore({ database });
    await healthyStore.initialize();
    const failingStore = createSqliteStore({
      database: createFailingSqliteDatabase(database, (sql) =>
        sql.includes('INSERT INTO operational_health_probe'),
      ),
    });

    await expect(failingStore.verifyOperationalWrite()).rejects.toThrow(
      'operational_write_verification_failed',
    );

    expect(
      database
        .prepare<{ count: number }>('SELECT COUNT(*) AS count FROM operational_health_probe')
        .get()?.count,
    ).toBe(0);
    expect(() => database.run('BEGIN IMMEDIATE')).not.toThrow();
    database.run('ROLLBACK');
  });

  it('upgrades a version 6 database with the operational health probe table', () => {
    const database = createBunSqliteDatabase(tempDatabasePath());
    database.run(
      `CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`,
    );
    database.run(
      `INSERT INTO schema_migrations (version, applied_at)
       VALUES (6, $appliedAt)`,
      { $appliedAt: now },
    );

    migrateSqliteStore(database);

    expect(
      database
        .prepare<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operational_health_probe'",
        )
        .get(),
    ).toEqual({ name: 'operational_health_probe' });
    expect(
      database
        .prepare<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations')
        .get(),
    ).toEqual({ version: 10 });
    database.close();
  });

  it('records schema version when migrations run repeatedly without clearing data', async () => {
    const database = createBunSqliteDatabase(tempDatabasePath());

    migrateSqliteStore(database);
    database.run(
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
      )`,
      {
        $captureEnabled: 1,
        $deviceId: 'device_1',
        $fetchedAt: now,
        $serverCapabilitiesJson: JSON.stringify({
          ocr: true,
          search: true,
          sync: true,
          timeline: true,
        }),
        $workspaceId: 'workspace_1',
      },
    );
    migrateSqliteStore(database);

    expect(
      database.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM schema_migrations').get()
        ?.count,
    ).toBe(1);
    expect(
      database.prepare<{ version: number }>('SELECT version FROM schema_migrations').get(),
    ).toEqual({
      version: 10,
    });
    expect(
      database.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM settings_cache').get()
        ?.count,
    ).toBe(1);

    database.close();
  });

  it('maintains device-wide admission statistics through outbox and asset state changes', async () => {
    const { database, store } = await createTempStoreWithDatabase();

    expect(toOperationalSnapshot(readOperationalStatistics(database))).toEqual({
      assetBytes: 0,
      queuedJobs: 0,
      retryingJobs: 0,
    });

    await store.createOutboxJob(createJob());
    await store.upsertAssetCacheRef(createAsset({ sizeBytes: 2048 }));
    await store.recordOutboxSafeError('job_1', {
      code: 'server_unavailable',
      maxAttempts: 5,
      message: 'Server is unavailable.',
      now: '2026-07-06T00:01:00.000Z',
      retryable: true,
      retryAt: '2026-07-06T00:02:00.000Z',
    });

    expect(toOperationalSnapshot(readOperationalStatistics(database))).toEqual({
      assetBytes: 2048,
      queuedJobs: 1,
      retryingJobs: 1,
    });

    await store.markOutboxJobTerminal('job_1', {
      now: '2026-07-06T00:03:00.000Z',
      reason: 'terminal_test',
      state: 'failed',
    });
    await store.claimAssetCleanup({
      assetRefId: 'asset_1',
      now: '2026-07-06T00:03:00.000Z',
    });
    await store.settleAssetCleanup({
      assetRefId: 'asset_1',
      cleanupState: 'cleaned',
      now: '2026-07-06T00:04:00.000Z',
    });

    expect(toOperationalSnapshot(readOperationalStatistics(database))).toEqual({
      assetBytes: 0,
      queuedJobs: 0,
      retryingJobs: 0,
    });
    expect(await store.getBackpressureSnapshot()).toEqual(
      toOperationalSnapshot(readOperationalStatistics(database)),
    );
  });

  it('adds asset availability columns to an existing early operational table', async () => {
    const database = createBunSqliteDatabase(tempDatabasePath());
    database.run(
      `CREATE TABLE asset_cache_refs (
        asset_ref_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        role TEXT NOT NULL,
        hash TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        cleanup_state TEXT NOT NULL,
        availability TEXT NOT NULL DEFAULT 'available',
        created_at TEXT NOT NULL,
        local_access_key TEXT NOT NULL,
        last_availability_error_json TEXT,
        content_address TEXT
      )`,
    );
    database.run(
      `INSERT INTO asset_cache_refs (
        asset_ref_id,
        workspace_id,
        role,
        hash,
        mime_type,
        size_bytes,
        cleanup_state,
        created_at,
        local_access_key
      ) VALUES (
        'asset_early',
        'workspace_1',
        'capture_original',
        'sha256:early',
        'image/png',
        128,
        'retained',
        $createdAt,
        'content-addressed/local/asset_early'
      )`,
      { $createdAt: now },
    );

    migrateSqliteStore(database);
    const store = createSqliteStore({ database });

    expect(await store.getAssetCacheRef('asset_early')).toMatchObject({
      assetRefId: 'asset_early',
      availabilityState: 'available',
    });

    const updated = await store.updateAssetRefAvailability({
      assetRefId: 'asset_early',
      availabilitySafeError: {
        code: 'local_asset_missing',
        message: 'Local asset is missing.',
        retryable: false,
      },
      availabilityState: 'missing',
      now: '2026-07-06T00:05:00.000Z',
    });

    expect(updated).toMatchObject({
      ok: true,
      value: {
        availabilityCheckedAt: '2026-07-06T00:05:00.000Z',
        availabilityState: 'missing',
      },
    });

    database.close();
  });

  it('maps malformed serialized values to storage_corruption consistently', async () => {
    const { database, store } = await createTempStoreWithDatabase();
    await store.createOutboxJob(createJob());
    await store.upsertAssetCacheRef(createAsset());
    await store.setSettingsCache({
      captureEnabled: true,
      deviceId: 'device_1',
      fetchedAt: now,
      serverCapabilities: { ocr: true, search: true, sync: true, timeline: true },
      workspaceId: 'workspace_1',
    });

    database.run('PRAGMA ignore_check_constraints = ON');
    database.run("UPDATE outbox_jobs SET capture_json = '{'");
    await expect(store.getOutboxJob('job_1')).rejects.toMatchObject({ code: 'storage_corruption' });

    database.run("UPDATE asset_cache_refs SET availability_safe_error_json = '{'");
    await expect(store.getAssetCacheRef('asset_1')).rejects.toMatchObject({
      code: 'storage_corruption',
    });

    database.run("UPDATE settings_cache SET server_capabilities_json = '{'");
    await expect(store.getSettingsCache('workspace_1')).rejects.toMatchObject({
      code: 'storage_corruption',
    });
    database.run('PRAGMA ignore_check_constraints = OFF');
  });

  it('rebuilds a v1 outbox_jobs table into the v2 shape, remapping the retired states', async () => {
    const database = createBunSqliteDatabase(tempDatabasePath());
    // Build the pre-migration (v1) shape: the old state CHECK set, a
    // `server_ocr_job_id` column, and no `ocr_result_json`.
    database.run(
      `CREATE TABLE outbox_jobs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        asset_ref_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        capture_json TEXT NOT NULL CHECK (json_valid(capture_json)),
        state TEXT NOT NULL CHECK (
          state IN ('pending', 'uploading', 'ocr_wait', 'synced', 'blocked', 'failed', 'cancelled')
        ),
        attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        next_retry_at TEXT,
        locked_at TEXT,
        server_capture_id TEXT,
        server_ocr_job_id TEXT,
        last_safe_error_json TEXT,
        terminal_reason TEXT,
        UNIQUE(workspace_id, idempotency_key)
      )`,
    );

    const insertV1Row = (row: {
      id: string;
      idempotencyKey: string;
      state: string;
      nextRetryAt?: string;
      lockedAt?: string;
      serverCaptureId?: string;
      serverOcrJobId?: string;
    }): void => {
      database.run(
        `INSERT INTO outbox_jobs (
          id, workspace_id, device_id, asset_ref_id, idempotency_key, payload_hash,
          capture_json, state, attempt, created_at, updated_at, next_retry_at,
          locked_at, server_capture_id, server_ocr_job_id
        ) VALUES (
          $id, 'workspace_1', 'device_1', 'asset_1', $idempotencyKey, 'sha256:aa',
          '{}', $state, 0, $now, $now, $nextRetryAt, $lockedAt, $serverCaptureId, $serverOcrJobId
        )`,
        {
          $id: row.id,
          $idempotencyKey: row.idempotencyKey,
          $lockedAt: row.lockedAt ?? null,
          $nextRetryAt: row.nextRetryAt ?? null,
          $now: now,
          $serverCaptureId: row.serverCaptureId ?? null,
          $serverOcrJobId: row.serverOcrJobId ?? null,
          $state: row.state,
        },
      );
    };

    insertV1Row({
      id: 'job_uploading',
      idempotencyKey: 'idem_uploading',
      lockedAt: now,
      state: 'uploading',
    });
    insertV1Row({
      id: 'job_ocr_wait',
      idempotencyKey: 'idem_ocr_wait',
      lockedAt: now,
      nextRetryAt: '2026-07-06T00:05:00.000Z',
      serverCaptureId: 'capture_ocr_wait',
      serverOcrJobId: 'server_ocr_wait',
      state: 'ocr_wait',
    });
    insertV1Row({ id: 'job_synced', idempotencyKey: 'idem_synced', state: 'synced' });

    migrateSqliteStore(database);

    const columns = new Set(
      database
        .prepare<{ name: string }>('PRAGMA table_info(outbox_jobs)')
        .all()
        .map((column) => column.name),
    );
    expect(columns.has('server_ocr_job_id')).toBe(false);
    expect(columns.has('ocr_result_json')).toBe(true);
    expect(
      database
        .prepare<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations')
        .get()?.version,
    ).toBe(10);

    const rowById = (id: string) =>
      database
        .prepare<{
          state: string;
          next_retry_at: string | null;
          locked_at: string | null;
          server_capture_id: string | null;
        }>(
          'SELECT state, next_retry_at, locked_at, server_capture_id FROM outbox_jobs WHERE id = $id',
        )
        .get({ $id: id });

    // `uploading` → `syncing`, in-flight lock preserved for startup recovery.
    expect(rowById('job_uploading')).toMatchObject({ locked_at: now, state: 'syncing' });
    // `ocr_wait` → `pending`, next_retry_at/locked_at cleared so it replays
    // immediately; the dropped server job id is gone, server_capture_id kept.
    expect(rowById('job_ocr_wait')).toMatchObject({
      locked_at: null,
      next_retry_at: null,
      server_capture_id: 'capture_ocr_wait',
      state: 'pending',
    });
    // Terminal rows copy across untouched — no queued work lost.
    expect(rowById('job_synced')).toMatchObject({ state: 'synced' });
    expect(
      database.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM outbox_jobs').get()?.count,
    ).toBe(3);

    database.close();
  });

  it('rolls back the v1 rebuild when migration fails after copying legacy rows', () => {
    const database = createBunSqliteDatabase(tempDatabasePath());
    createLegacyOutboxTable(database);
    database.run(
      `INSERT INTO outbox_jobs (
        id, workspace_id, device_id, asset_ref_id, idempotency_key, payload_hash,
        capture_json, state, attempt, created_at, updated_at, next_retry_at,
        locked_at, server_capture_id, server_ocr_job_id
      ) VALUES (
        'job_legacy', 'workspace_1', 'device_1', 'asset_1', 'idem_legacy', 'sha256:aa',
        '{}', 'ocr_wait', 0, $now, $now, $now, $now, 'capture_1', 'ocr_legacy'
      )`,
      { $now: now },
    );
    const failingDatabase = createFailingSqliteDatabase(database, (sql) =>
      sql.includes('DROP TABLE outbox_jobs'),
    );

    expect(() => migrateSqliteStore(failingDatabase)).toThrow('injected_sqlite_failure');

    const columns = new Set(
      database
        .prepare<{ name: string }>('PRAGMA table_info(outbox_jobs)')
        .all()
        .map((column) => column.name),
    );
    expect(columns.has('server_ocr_job_id')).toBe(true);
    expect(columns.has('ocr_result_json')).toBe(false);
    expect(
      database
        .prepare<{ server_ocr_job_id: string; state: string }>(
          'SELECT state, server_ocr_job_id FROM outbox_jobs WHERE id = $id',
        )
        .get({ $id: 'job_legacy' }),
    ).toEqual({ server_ocr_job_id: 'ocr_legacy', state: 'ocr_wait' });
    expect(
      database
        .prepare<{ count: number }>(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'outbox_jobs__v2'",
        )
        .get()?.count,
    ).toBe(0);

    database.close();
  });

  it('initializes schema idempotently and restores operational state after close and reopen', async () => {
    const path = tempDatabasePath();
    const firstDatabase = createBunSqliteDatabase(path);
    const first = createSqliteStore({ database: firstDatabase });

    await first.initialize();
    await first.initialize();
    await first.upsertAssetCacheRef(createAsset({ localAccessKey: '/Users/alice/secret.png' }));
    await first.createOutboxJob(createJob());
    await first.setPolicyCache({
      deviceId: 'device_1',
      fetchedAt: now,
      policy: {
        axTextUploadEnabled: false,
        defaultAction: 'allow',
        paused: false,
        rules: [],
      },
      policySnapshotId: 'snapshot_primary',
      policyVersion: 'policy_primary',
      ttlSeconds: 120,
      maxConcurrentOcr: 3,
      workspaceId: 'workspace_1',
    });
    await first.setSyncCursor({
      cursor: 'cursor_1',
      etag: 'etag_1',
      kind: 'timeline',
      updatedAt: now,
      workspaceId: 'workspace_1',
    });
    await first.setSettingsCache({
      captureEnabled: true,
      deviceId: 'device_1',
      fetchedAt: now,
      serverCapabilities: {
        ocr: true,
        search: true,
        sync: true,
        timeline: true,
      },
      workspaceId: 'workspace_1',
    });
    await first.upsertLocalCapturePolicyRule({
      action: 'block_capture',
      createdAt: now,
      enabled: true,
      id: 'local-sensitive-app',
      kind: 'bundle_id',
      pattern: 'com.example.sensitive',
      scope: 'local_user',
      updatedAt: now,
    });
    first.close();

    const reopenedDatabase = createBunSqliteDatabase(path);
    const reopened = createSqliteStore({ database: reopenedDatabase });
    await reopened.initialize();
    expect(await reopened.listLocalCapturePolicyRules()).toEqual([
      {
        action: 'block_capture',
        createdAt: now,
        enabled: true,
        id: 'local-sensitive-app',
        kind: 'bundle_id',
        pattern: 'com.example.sensitive',
        scope: 'local_user',
        updatedAt: now,
      },
    ]);

    expect(await reopened.getOutboxJob('job_1')).toMatchObject({
      capture: {
        privacyDecision: {
          decidedAt: now,
        },
      },
      id: 'job_1',
      state: 'pending',
    });
    expect(await reopened.getAssetCacheRef('asset_1')).toMatchObject({
      assetRefId: 'asset_1',
      localAccessKey: '/Users/alice/secret.png',
    });
    expect(await reopened.getPolicyCache('workspace_1', 'device_1', { now })).toMatchObject({
      expired: false,
      maxConcurrentOcr: 3,
      policyVersion: 'policy_primary',
    });
    expect(await reopened.getSyncCursor('workspace_1', 'timeline')).toMatchObject({
      cursor: 'cursor_1',
      etag: 'etag_1',
    });
    expect(await reopened.getSettingsCache('workspace_1')).toMatchObject({
      captureEnabled: true,
      deviceId: 'device_1',
    });

    reopened.close();
  });

  it('persists explicit startup recovery after SQLite close and reopen', async () => {
    const path = tempDatabasePath();
    const firstDatabase = createBunSqliteDatabase(path);
    const first = createSqliteStore({ database: firstDatabase });

    await first.initialize();
    await first.upsertAssetCacheRef(createAsset());
    await first.createOutboxJob(createJob());
    await first.updateOutboxJobState('job_1', {
      now: '2026-07-06T00:01:00.000Z',
      state: 'syncing',
    });
    await first.createOutboxJob(
      createJob({
        assetRefId: 'asset_2',
        id: 'job_result_pending',
        idempotencyKey: 'idem_result_pending',
      }),
    );
    await first.updateOutboxJobState('job_result_pending', {
      now: '2026-07-06T00:02:00.000Z',
      ocrResult: createStoredOcrResult(),
      serverCaptureId: 'capture_result_pending',
      state: 'result_pending',
    });
    await first.createOutboxJob(
      createJob({
        assetRefId: 'asset_3',
        id: 'job_cancelled',
        idempotencyKey: 'idem_cancelled',
      }),
    );
    await first.markOutboxJobTerminal('job_cancelled', {
      now: '2026-07-06T00:03:00.000Z',
      reason: 'user_cancelled',
      state: 'cancelled',
    });

    const summary = await recoverSyncQueue({
      now: '2026-07-06T00:10:00.000Z',
      store: first,
    });
    first.close();

    const reopenedDatabase = createBunSqliteDatabase(path);
    const reopened = createSqliteStore({ database: reopenedDatabase });
    await reopened.initialize();

    expect(summary).toEqual({
      reconciledSynced: 0,
      recovered: 2,
      resultSubmitInterrupted: 1,
      scanned: 2,
      syncInterrupted: 1,
    });
    expect(await reopened.getOutboxJob('job_1')).toMatchObject({
      lastSafeError: {
        code: 'interrupted_during_sync',
        retryable: true,
      },
      nextRetryAt: '2026-07-06T00:10:00.000Z',
      state: 'pending',
    });
    expect((await reopened.getOutboxJob('job_1'))?.lockedAt).toBeUndefined();
    expect(await reopened.getOutboxJob('job_result_pending')).toMatchObject({
      lastSafeError: {
        code: 'interrupted_before_result_submit',
        retryable: true,
      },
      ocrResult: {
        sourceAssetHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      },
      serverCaptureId: 'capture_result_pending',
      state: 'pending',
    });
    expect((await reopened.getOutboxJob('job_result_pending'))?.lockedAt).toBeUndefined();
    expect(await reopened.getOutboxJob('job_cancelled')).toMatchObject({
      state: 'cancelled',
      terminalReason: 'user_cancelled',
    });

    reopened.close();
  });

  it('enforces workspace-scoped outbox idempotency while allowing the same key in another workspace', async () => {
    const store = await createTempStore();

    const first = await store.createOutboxJob(createJob());
    const duplicate = await store.createOutboxJob(createJob({ id: 'job_2' }));
    const otherWorkspace = await store.createOutboxJob(
      createJob({
        id: 'job_3',
        workspaceId: 'workspace_2',
      }),
    );

    expect(first.ok).toBe(true);
    expect(duplicate).toEqual({
      ok: false,
      error: {
        code: 'idempotency_key_conflict',
        message: 'Outbox idempotency key already exists for this workspace.',
      },
    });
    expect(otherWorkspace.ok).toBe(true);
  });

  it('maps duplicate outbox primary keys to a typed result instead of leaking SQLite errors', async () => {
    const store = await createTempStore();

    const first = await store.createOutboxJob(createJob());
    const duplicateId = await store.createOutboxJob(
      createJob({
        idempotencyKey: 'idem_2',
      }),
    );

    expect(first.ok).toBe(true);
    expect(duplicateId).toEqual({
      ok: false,
      error: {
        code: 'outbox_job_id_conflict',
        message: 'Outbox job id already exists.',
      },
    });
  });

  it('creates capture outbox entries in a transaction and rolls back asset refs on capacity failure', async () => {
    const database = createBunSqliteDatabase(tempDatabasePath());
    const store = createSqliteStore({ database, maxActiveOutboxJobs: 0 });
    await store.initialize();

    const result = await store.createCaptureOutboxEntry({
      ...createJob(),
      assetRefs: [createAsset()],
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'capacity_exceeded',
        message: 'Outbox active job capacity has been reached.',
      },
    });
    expect(await store.getAssetCacheRef('asset_1')).toBeNull();
    expect(await store.getOutboxJob('job_1')).toBeNull();

    store.close();
  });

  it('replays an accepted capture at capacity but rejects a new capture atomically', async () => {
    const database = createBunSqliteDatabase(tempDatabasePath());
    const store = createSqliteStore({ database, maxActiveOutboxJobs: 1 });
    await store.initialize();
    const entry = {
      ...createJob(),
      assetRefs: [createAsset()],
    };

    const first = await store.createCaptureOutboxEntry(entry);
    const replay = await store.createCaptureOutboxEntry(entry);
    const overflow = await store.createCaptureOutboxEntry({
      ...createJob({
        assetRefId: 'asset_2',
        id: 'job_2',
        idempotencyKey: 'idem_2',
      }),
      assetRefs: [createAsset({ assetRefId: 'asset_2' })],
    });

    expect(first.ok).toBe(true);
    expect(replay).toMatchObject({ ok: true, value: { id: 'job_1' } });
    expect(overflow).toEqual({
      ok: false,
      error: {
        code: 'capacity_exceeded',
        message: 'Outbox active job capacity has been reached.',
      },
    });
    expect(await store.listOutboxJobs({ workspaceId: 'workspace_1' })).toHaveLength(1);
    expect(await store.getAssetCacheRef('asset_2')).toBeNull();

    store.close();
  });

  it('rolls back written asset refs when the outbox insert throws', async () => {
    const database = createBunSqliteDatabase(tempDatabasePath());
    let assetWriteObserved = false;
    const failingDatabase = createFailingSqliteDatabase(
      database,
      (sql) => sql.includes('INSERT INTO outbox_jobs ('),
      () => {
        assetWriteObserved =
          database
            .prepare<{ count: number }>('SELECT COUNT(*) AS count FROM asset_cache_refs')
            .get()?.count === 1;
      },
    );
    const store = createSqliteStore({ database: failingDatabase });
    await store.initialize();

    await expect(
      store.createCaptureOutboxEntry({
        ...createJob(),
        assetRefs: [createAsset()],
      }),
    ).rejects.toThrow('injected_sqlite_failure');

    expect(assetWriteObserved).toBe(true);
    expect(
      database.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM asset_cache_refs').get()
        ?.count,
    ).toBe(0);
    expect(
      database.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM outbox_jobs').get()?.count,
    ).toBe(0);

    store.close();
  });

  it('acks identical capture outbox entries and rejects divergent idempotency without overwriting asset refs', async () => {
    const store = await createTempStore();
    const entry = {
      ...createJob(),
      assetRefs: [createAsset()],
    };

    const first = await store.createCaptureOutboxEntry(entry);
    const identical = await store.createCaptureOutboxEntry(entry);
    const divergent = await store.createCaptureOutboxEntry({
      ...entry,
      assetRefs: [
        createAsset({
          hash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        }),
      ],
      payloadHash: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    });

    expect(first.ok).toBe(true);
    expect(identical).toMatchObject({
      ok: true,
      value: {
        id: 'job_1',
        state: 'pending',
      },
    });
    expect(divergent).toEqual({
      ok: false,
      error: {
        code: 'idempotency_key_conflict',
        message: 'Outbox idempotency key already exists for this workspace.',
      },
    });
    expect(await store.getAssetCacheRef('asset_1')).toMatchObject({
      hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
  });

  it('supports outbox claim, retry, terminal, and terminal guard behavior', async () => {
    const store = await createTempStore();
    await store.createOutboxJob(
      createJob({
        id: 'job_later',
        idempotencyKey: 'idem_later',
        nextRetryAt: '2026-07-06T00:05:00.000Z',
      }),
    );
    await store.createOutboxJob(
      createJob({
        id: 'job_ready',
        idempotencyKey: 'idem_ready',
        nextRetryAt: '2026-07-06T00:01:00.000Z',
      }),
    );

    const claimed = await store.claimNextRetryableOutboxJob({
      maxAttempts: 5,
      now: '2026-07-06T00:02:00.000Z',
      workspaceId: 'workspace_1',
    });
    await expect(
      store.getOutboxSummary({
        minuteAgo: '2026-07-06T00:01:00.000Z',
        now: '2026-07-06T00:02:00.000Z',
        workspaceId: 'workspace_1',
      }),
    ).resolves.toMatchObject({
      nextRetryAt: '2026-07-06T00:05:00.000Z',
      retrying: 1,
    });
    const retry = await store.recordOutboxSafeError('job_ready', {
      code: 'provider_unavailable',
      leaseToken: claimed?.leaseToken,
      maxAttempts: 3,
      message: 'Provider is unavailable.',
      now: '2026-07-06T00:02:30.000Z',
      retryable: true,
      retryAt: '2026-07-06T00:03:30.000Z',
    });
    const terminal = await store.markOutboxJobTerminal('job_ready', {
      now: '2026-07-06T00:04:00.000Z',
      reason: 'user_cancelled',
      state: 'cancelled',
    });
    const retryCancelled = await store.recordOutboxSafeError('job_ready', {
      code: 'provider_unavailable',
      maxAttempts: 3,
      message: 'Should not retry.',
      now: '2026-07-06T00:04:30.000Z',
      retryable: true,
      retryAt: '2026-07-06T00:05:30.000Z',
    });
    const lateSuccess = await store.markOutboxJobTerminal('job_ready', {
      now: '2026-07-06T00:05:00.000Z',
      reason: 'ocr_synced',
      serverCaptureId: 'capture_1',
      state: 'synced',
    });

    expect(claimed).toMatchObject({
      id: 'job_ready',
      lockedAt: '2026-07-06T00:02:00.000Z',
      state: 'syncing',
    });
    expect(claimed?.nextRetryAt).toBeUndefined();
    expect(retry).toMatchObject({
      ok: true,
      value: {
        attempt: 1,
        lastSafeError: {
          code: 'provider_unavailable',
          retryable: true,
        },
        nextRetryAt: '2026-07-06T00:03:30.000Z',
        state: 'pending',
      },
    });
    expect(terminal).toMatchObject({
      ok: true,
      value: {
        state: 'cancelled',
        terminalReason: 'user_cancelled',
      },
    });
    expect(terminal.ok ? terminal.value.nextRetryAt : 'unexpected failure').toBeUndefined();
    expect(retryCancelled).toEqual({
      ok: false,
      error: {
        code: 'terminal_state_conflict',
        message: 'Terminal outbox jobs cannot be retried.',
      },
    });
    expect(lateSuccess).toEqual({
      ok: false,
      error: {
        code: 'terminal_state_conflict',
        message: 'Terminal outbox jobs cannot transition to another terminal state.',
      },
    });
    expect(
      await store.claimNextRetryableOutboxJob({
        maxAttempts: 5,
        now: '2026-07-06T00:10:00.000Z',
        workspaceId: 'workspace_1',
      }),
    ).toMatchObject({
      id: 'job_later',
      state: 'syncing',
    });
  });

  it('requeues failed and blocked jobs for one workspace without reviving cancelled work', async () => {
    const store = await createTempStore();
    await store.createOutboxJob(createJob({ id: 'job_failed' }));
    await store.createOutboxJob(createJob({ id: 'job_blocked', idempotencyKey: 'idem_blocked' }));
    await store.createOutboxJob(
      createJob({ id: 'job_cancelled', idempotencyKey: 'idem_cancelled' }),
    );
    await store.createOutboxJob(
      createJob({
        id: 'job_other_workspace',
        idempotencyKey: 'idem_other_workspace',
        workspaceId: 'workspace_2',
      }),
    );

    await store.recordOutboxSafeError('job_failed', {
      code: 'provider_auth_failed',
      maxAttempts: 1,
      message: 'Provider authentication failed.',
      now: '2026-07-06T00:00:05.000Z',
      retryable: false,
    });
    for (const [id, state, reason] of [
      ['job_blocked', 'blocked', 'local_asset_missing'],
      ['job_cancelled', 'cancelled', 'user_cancelled'],
      ['job_other_workspace', 'failed', 'provider_auth_failed'],
    ] as const) {
      await store.markOutboxJobTerminal(id, {
        now: '2026-07-06T00:00:06.000Z',
        reason,
        state,
      });
    }

    expect(
      await store.requeueTerminalOutboxJobs({
        now: '2026-07-06T00:10:00.000Z',
        workspaceId: 'workspace_1',
      }),
    ).toBe(2);
    expect(await store.getOutboxJob('job_failed')).toMatchObject({
      attempt: 0,
      nextRetryAt: '2026-07-06T00:10:00.000Z',
      state: 'pending',
    });
    expect((await store.getOutboxJob('job_failed'))?.lastSafeError).toBeUndefined();
    expect((await store.getOutboxJob('job_failed'))?.terminalReason).toBeUndefined();
    expect(await store.getOutboxJob('job_blocked')).toMatchObject({
      attempt: 0,
      state: 'pending',
    });
    expect(await store.getOutboxJob('job_cancelled')).toMatchObject({ state: 'cancelled' });
    expect(await store.getOutboxJob('job_other_workspace')).toMatchObject({ state: 'failed' });

    const claimed = await store.claimNextRetryableOutboxJob({
      maxAttempts: 3,
      now: '2026-07-06T00:10:00.000Z',
      workspaceId: 'workspace_1',
    });
    expect(['job_failed', 'job_blocked']).toContain(claimed?.id ?? 'missing');
  });

  it('releases a claimed job without incrementing attempts when the provider gate closes', async () => {
    const store = await createTempStore();
    await store.createOutboxJob(createJob());
    const claimed = await store.claimNextRetryableOutboxJob({
      maxAttempts: 3,
      now,
      workspaceId: 'workspace_1',
    });

    const released = await store.releaseOutboxJob({
      id: 'job_1',
      lastSafeError: {
        code: 'provider_auth_failed',
        message: 'Provider authentication failed.',
        retryable: true,
      },
      leaseToken: claimed?.leaseToken,
      now: '2026-07-06T00:00:05.000Z',
    });

    expect(released).toMatchObject({
      ok: true,
      value: {
        attempt: 0,
        lastSafeError: { code: 'provider_auth_failed', retryable: true },
        nextRetryAt: '2026-07-06T00:00:05.000Z',
        state: 'pending',
      },
    });
    expect(released.ok ? released.value.leaseToken : 'unexpected failure').toBeUndefined();
    expect(released.ok ? released.value.terminalReason : 'unexpected failure').toBeUndefined();
  });

  it('uses lease-token compare-and-set so an old worker cannot overwrite a reclaimed job', async () => {
    const store = await createTempStore();
    await store.createOutboxJob(createJob({ id: 'job_lease', idempotencyKey: 'idem_lease' }));

    const first = await store.claimNextRetryableOutboxJob({
      maxAttempts: 3,
      now: '2026-07-06T00:00:00.000Z',
      workspaceId: 'workspace_1',
    });
    await store.recoverInterruptedOutboxJob({
      id: 'job_lease',
      lastSafeError: {
        code: 'interrupted_during_sync',
        message: 'Outbox sync was interrupted before startup recovery.',
        retryable: true,
      },
      leaseToken: first?.leaseToken,
      nextRetryAt: '2026-07-06T00:00:01.000Z',
      now: '2026-07-06T00:00:01.000Z',
    });
    const second = await store.claimNextRetryableOutboxJob({
      maxAttempts: 3,
      now: '2026-07-06T00:00:01.000Z',
      workspaceId: 'workspace_1',
    });

    const staleRelease = await store.releaseOutboxJob({
      id: 'job_lease',
      lastSafeError: {
        code: 'provider_auth_failed',
        message: 'Provider authentication failed.',
        retryable: true,
      },
      leaseToken: first?.leaseToken,
      now: '2026-07-06T00:00:02.000Z',
    });
    const stale = await store.markOutboxJobTerminal('job_lease', {
      leaseToken: first?.leaseToken,
      now: '2026-07-06T00:00:03.000Z',
      reason: 'ocr_synced',
      state: 'synced',
    });
    const current = await store.markOutboxJobTerminal('job_lease', {
      leaseToken: second?.leaseToken,
      now: '2026-07-06T00:00:04.000Z',
      reason: 'ocr_synced',
      state: 'synced',
    });

    expect(staleRelease).toMatchObject({ ok: false, error: { code: 'outbox_lease_lost' } });
    expect(stale).toMatchObject({ ok: false, error: { code: 'outbox_lease_lost' } });
    expect(current).toMatchObject({ ok: true, value: { state: 'synced' } });
  });

  it('keeps a stale terminal update from overwriting a concurrent cancellation', async () => {
    const { database, store } = await createTempStoreWithDatabase();
    await store.createOutboxJob(createJob());

    database.run(
      `UPDATE outbox_jobs
       SET state = 'cancelled',
           terminal_reason = 'user_cancelled',
           updated_at = $updatedAt
       WHERE id = $id`,
      {
        $id: 'job_1',
        $updatedAt: '2026-07-06T00:00:10.000Z',
      },
    );

    const lateSuccess = await store.updateOutboxJobState('job_1', {
      now: '2026-07-06T00:00:11.000Z',
      serverCaptureId: 'capture_late',
      state: 'synced',
    });
    const stored = await store.getOutboxJob('job_1');

    expect(lateSuccess).toEqual({
      ok: false,
      error: {
        code: 'terminal_state_conflict',
        message: 'Terminal outbox jobs cannot transition to another state.',
      },
    });
    expect(stored?.serverCaptureId).toBeUndefined();
    expect(stored).toMatchObject({
      state: 'cancelled',
      terminalReason: 'user_cancelled',
    });
  });

  it('normalizes CapturePrivacyDecision.decidedAt and persists the normalized payload', async () => {
    const path = tempDatabasePath();
    const database = createBunSqliteDatabase(path);
    const first = createSqliteStore({ database });
    await first.initialize();
    await first.createOutboxJob(
      createJob({
        capture: {
          capturedAt: '2026-07-06T00:00:03.000Z',
          observedAt: '2026-07-06T00:00:05.000Z',
          privacyDecision: {
            action: 'redact_context',
            policyVersion: 'policy_redact',
            reasons: ['site_rule'],
          },
        },
      }),
    );
    first.close();

    const reopenedDatabase = createBunSqliteDatabase(path);
    const reopened = createSqliteStore({ database: reopenedDatabase });
    await reopened.initialize();

    expect(await reopened.getOutboxJob('job_1')).toMatchObject({
      capture: {
        capturedAt: '2026-07-06T00:00:03.000Z',
        observedAt: '2026-07-06T00:00:05.000Z',
        privacyDecision: {
          action: 'redact_context',
          decidedAt: '2026-07-06T00:00:05.000Z',
          policyVersion: 'policy_redact',
          reasons: ['site_rule'],
        },
      },
    });

    reopened.close();
  });

  it('upserts asset refs and keeps renderer projections free of local absolute paths', async () => {
    const store = await createTempStore();
    await store.upsertAssetCacheRef(
      createAsset({
        contentAddress: 'sha256/asset_1',
        localAccessKey: '/Users/alice/Pictures/recapsy/private.png',
      }),
    );
    await store.upsertAssetCacheRef(
      createAsset({
        cleanupState: 'cleanup_pending',
        contentAddress: 'sha256/asset_1',
        localAccessKey: '/Users/alice/Pictures/recapsy/private-updated.png',
        sizeBytes: 4096,
      }),
    );

    const asset = await store.getAssetCacheRef('asset_1');
    const listed = await store.listAssetCacheRefs('workspace_1');
    if (!asset) {
      throw new Error('Expected asset ref to exist.');
    }

    const projection = toRendererSafeAssetRef(asset);
    const serialized = JSON.stringify(projection);

    expect(listed).toHaveLength(1);
    expect(asset).toMatchObject({
      contentAddress: 'sha256/asset_1',
      localAccessKey: '/Users/alice/Pictures/recapsy/private-updated.png',
      sizeBytes: 4096,
    });
    expect(projection).toEqual({
      assetRefId: 'asset_1',
      availabilityCheckedAt: undefined,
      availabilitySafeError: undefined,
      availabilityState: 'available',
      cleanupState: 'cleanup_pending',
      createdAt: now,
      mimeType: 'image/png',
      role: 'capture_original',
      sizeBytes: 4096,
    });
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('localAccessKey');
    expect(serialized).not.toContain('contentAddress');
  });

  it('persists cleanup claim, completion, and interrupted recovery without deleting the asset record', async () => {
    const path = tempDatabasePath();
    const firstDatabase = createBunSqliteDatabase(path);
    const first = createSqliteStore({ database: firstDatabase });
    await first.initialize();
    await first.upsertAssetCacheRef(createAsset());

    const claimed = await first.claimAssetCleanup({ assetRefId: 'asset_1', now });
    expect(claimed).toMatchObject({ cleanupState: 'cleanup_pending', cleanupUpdatedAt: now });
    first.close();

    const secondDatabase = createBunSqliteDatabase(path);
    const second = createSqliteStore({ database: secondDatabase });
    await second.initialize();
    expect(
      await second.recoverPendingAssetCleanup({
        now: '2026-07-06T00:01:00.000Z',
        workspaceId: 'workspace_1',
      }),
    ).toBe(1);
    expect(await second.getAssetCacheRef('asset_1')).toMatchObject({
      cleanupSafeError: { code: 'local_asset_cleanup_interrupted', retryable: true },
      cleanupState: 'cleanup_failed',
    });

    expect(
      await second.claimAssetCleanup({ assetRefId: 'asset_1', now: '2026-07-06T00:02:00.000Z' }),
    ).toMatchObject({ cleanupState: 'cleanup_pending' });
    const settled = await second.settleAssetCleanup({
      assetRefId: 'asset_1',
      cleanupState: 'cleaned',
      now: '2026-07-06T00:03:00.000Z',
    });

    expect(settled).toMatchObject({
      ok: true,
      value: {
        availabilityState: 'missing',
        cleanupState: 'cleaned',
        cleanupUpdatedAt: '2026-07-06T00:03:00.000Z',
      },
    });
    expect(await second.getAssetCacheRef('asset_1')).toMatchObject({ assetRefId: 'asset_1' });
    second.close();
  });

  it('persists asset ref reconciliation state and blocked jobs after close and reopen', async () => {
    const path = tempDatabasePath();
    const firstDatabase = createBunSqliteDatabase(path);
    const first = createSqliteStore({ database: firstDatabase });

    await first.initialize();
    await first.upsertAssetCacheRef(
      createAsset({
        contentAddress: 'sha256/private-content',
        localAccessKey: '/Users/alice/Pictures/recapsy/private.png',
      }),
    );
    await first.createOutboxJob(createJob());

    const summary = await reconcileActiveAssetRefs({
      now: '2026-07-06T00:05:00.000Z',
      resolver: {
        async checkAvailability() {
          return { availabilityState: 'missing' };
        },
      },
      store: first,
      workspaceId: 'workspace_1',
    });
    first.close();

    const reopenedDatabase = createBunSqliteDatabase(path);
    const reopened = createSqliteStore({ database: reopenedDatabase });
    await reopened.initialize();

    const asset = await reopened.getAssetCacheRef('asset_1');
    if (!asset) {
      throw new Error('Expected asset ref to exist.');
    }
    const projection = toRendererSafeAssetRef(asset);
    const serializedProjection = JSON.stringify(projection);
    const serializedSummary = JSON.stringify(summary);

    expect(summary).toMatchObject({
      blocked: 1,
      checked: 1,
      missing: 1,
    });
    expect(asset).toMatchObject({
      availabilityCheckedAt: '2026-07-06T00:05:00.000Z',
      availabilitySafeError: {
        code: 'local_asset_missing',
        message: 'Local asset is missing.',
        retryable: false,
      },
      availabilityState: 'missing',
      localAccessKey: '/Users/alice/Pictures/recapsy/private.png',
    });
    expect(await reopened.getOutboxJob('job_1')).toMatchObject({
      lastSafeError: {
        code: 'local_asset_missing',
        message: 'Local asset is missing.',
        retryable: false,
      },
      state: 'blocked',
      terminalReason: 'local_asset_missing',
    });
    expect(serializedProjection).not.toContain('/Users/alice');
    expect(serializedProjection).not.toContain('localAccessKey');
    expect(serializedProjection).not.toContain('contentAddress');
    expect(serializedSummary).not.toContain('/Users/alice');
    expect(serializedSummary).not.toContain('localAccessKey');
    expect(serializedSummary).not.toContain('contentAddress');

    reopened.close();
  });

  it('paginates historical assets without returning active local-byte dependencies', async () => {
    const store = await createTempStore();
    await store.upsertAssetCacheRef(createAsset({ assetRefId: 'asset_1' }));
    await store.upsertAssetCacheRef(createAsset({ assetRefId: 'asset_2' }));
    await store.upsertAssetCacheRef(createAsset({ assetRefId: 'asset_3' }));
    await store.createOutboxJob(
      createJob({
        assetRefId: 'asset_2',
        id: 'job_active_asset',
        idempotencyKey: 'idem_active_asset',
      }),
    );

    const firstPage = await store.listHistoricalAssetRefPage({
      limit: 1,
      workspaceId: 'workspace_1',
    });
    const secondPage = await store.listHistoricalAssetRefPage({
      afterAssetRefId: firstPage[0]?.assetRefId,
      limit: 2,
      workspaceId: 'workspace_1',
    });

    expect(firstPage.map((asset) => asset.assetRefId)).toEqual(['asset_1']);
    expect(secondPage.map((asset) => asset.assetRefId)).toEqual(['asset_3']);
  });

  it('expires policy cache entries by TTL and persists sync cursor and settings cache', async () => {
    const store = await createTempStore();
    await store.setPolicyCache({
      deviceId: 'device_1',
      fetchedAt: '2026-07-06T00:00:00.000Z',
      policy: {
        axTextUploadEnabled: false,
        defaultAction: 'allow',
        paused: false,
        rules: [],
      },
      policySnapshotId: 'snapshot_primary',
      policyVersion: 'policy_primary',
      ttlSeconds: 60,
      workspaceId: 'workspace_1',
    });
    await store.setSyncCursor({
      cursor: 'cursor_search',
      kind: 'search',
      updatedAt: now,
      workspaceId: 'workspace_1',
    });
    await store.setSettingsCache({
      captureEnabled: false,
      deviceId: 'device_1',
      fetchedAt: now,
      serverCapabilities: {
        ocr: true,
        search: true,
        sync: false,
        timeline: true,
      },
      workspaceId: 'workspace_1',
    });

    expect(
      await store.getPolicyCache('workspace_1', 'device_1', {
        now: '2026-07-06T00:00:30.000Z',
      }),
    ).toMatchObject({
      expired: false,
      policyVersion: 'policy_primary',
    });
    expect(
      await store.getPolicyCache('workspace_1', 'device_1', {
        now: '2026-07-06T00:01:01.000Z',
      }),
    ).toMatchObject({
      expired: true,
    });
    expect(await store.getSyncCursor('workspace_1', 'search')).toMatchObject({
      cursor: 'cursor_search',
    });
    expect(await store.getSettingsCache('workspace_1')).toMatchObject({
      captureEnabled: false,
      serverCapabilities: {
        sync: false,
      },
    });
  });

  it('clears workspace cache and sign-out cache with scoped behavior', async () => {
    const store = await createTempStore();
    await store.createOutboxJob(createJob());
    await store.createOutboxJob(
      createJob({
        assetRefId: 'asset_2',
        id: 'job_2',
        idempotencyKey: 'idem_2',
        workspaceId: 'workspace_2',
      }),
    );
    await store.upsertAssetCacheRef(createAsset());
    await store.upsertAssetCacheRef(
      createAsset({
        assetRefId: 'asset_2',
        workspaceId: 'workspace_2',
      }),
    );
    await store.setPolicyCache({
      deviceId: 'device_1',
      fetchedAt: now,
      policy: {
        axTextUploadEnabled: false,
        defaultAction: 'allow',
        paused: false,
        rules: [],
      },
      policySnapshotId: 'snapshot_primary',
      policyVersion: 'policy_primary',
      ttlSeconds: 60,
      workspaceId: 'workspace_1',
    });
    await store.setSettingsCache({
      captureEnabled: true,
      deviceId: 'device_2',
      fetchedAt: now,
      serverCapabilities: {
        ocr: false,
        search: false,
        sync: false,
        timeline: false,
      },
      workspaceId: 'workspace_2',
    });

    await store.clearWorkspaceCache('workspace_1');

    expect(await store.getOutboxJob('job_1')).toBeNull();
    expect(await store.getAssetCacheRef('asset_1')).toBeNull();
    expect(await store.getPolicyCache('workspace_1', 'device_1', { now })).toBeNull();
    expect(await store.getOutboxJob('job_2')).toMatchObject({
      workspaceId: 'workspace_2',
    });
    expect(await store.getAssetCacheRef('asset_2')).toMatchObject({
      workspaceId: 'workspace_2',
    });
    await store.clearSignOutCache();

    expect(await store.getOutboxJob('job_2')).toBeNull();
    expect(await store.getAssetCacheRef('asset_2')).toBeNull();
    expect(await store.getSettingsCache('workspace_2')).toBeNull();
  });

  it('supports backpressure snapshot and shared sync queue summary helpers', async () => {
    const store = await createTempStore();
    await store.createOutboxJob(createJob());
    await store.createOutboxJob(
      createJob({
        assetRefId: 'asset_2',
        id: 'job_2',
        idempotencyKey: 'idem_2',
      }),
    );
    await store.upsertAssetCacheRef(createAsset({ sizeBytes: 2048 }));
    await store.upsertAssetCacheRef(
      createAsset({
        assetRefId: 'asset_2',
        sizeBytes: 2048,
      }),
    );
    await store.recordOutboxSafeError('job_2', {
      code: 'server_unavailable',
      maxAttempts: 5,
      message: 'Server is unavailable.',
      now: '2026-07-06T00:01:00.000Z',
      retryable: true,
      retryAt: '2026-07-06T00:02:00.000Z',
    });

    const snapshot = await store.getBackpressureSnapshot();
    const backpressure = evaluateOperationalStoreBackpressure(snapshot, {
      maxAssetBytes: 4096,
      maxQueuedJobs: 2,
      maxRetryingJobs: 1,
      resumeAssetBytes: 2048,
      resumeQueuedJobs: 1,
      resumeRetryingJobs: 0,
    });
    const summary = await createSyncQueueSummary(store, 'workspace_1', { backpressure });

    expect(snapshot).toEqual({
      assetBytes: 4096,
      queuedJobs: 2,
      retryingJobs: 1,
    });
    expect(summary).toMatchObject({
      backpressure: {
        active: true,
        reasons: [
          'max_queued_jobs_reached',
          'max_retrying_jobs_reached',
          'max_asset_bytes_reached',
        ],
      },
      pending: 2,
      retrying: 1,
    });
  });
});

async function createTempStore(): Promise<ReturnType<typeof createSqliteStore>> {
  const { store } = await createTempStoreWithDatabase();
  return store;
}

async function createTempStoreWithDatabase(): Promise<{
  database: SqliteDatabase;
  store: ReturnType<typeof createSqliteStore>;
}> {
  const database = createBunSqliteDatabase(tempDatabasePath());
  const store = createSqliteStore({ database });
  await store.initialize();
  return { database, store };
}

function tempDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'recapsy-sqlite-store-'));
  tempDirs.push(dir);
  return join(dir, 'operational.sqlite');
}

function createJob(overrides: Partial<OutboxJobCreateInput> = {}): OutboxJobCreateInput {
  return {
    assetRefId: 'asset_1',
    createdAt: now,
    deviceId: 'device_1',
    id: 'job_1',
    idempotencyKey: 'idem_1',
    payloadHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    workspaceId: 'workspace_1',
    ...overrides,
  };
}

function createAsset(overrides: Partial<AssetCacheRef> = {}): AssetCacheRef {
  return {
    assetRefId: 'asset_1',
    availabilityState: 'available',
    cleanupState: 'retained',
    createdAt: now,
    hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    localAccessKey: 'content-addressed/local/asset_1',
    mimeType: 'image/png',
    role: 'capture_original',
    sizeBytes: 2048,
    workspaceId: 'workspace_1',
    ...overrides,
  };
}

function createLegacyOutboxTable(database: SqliteDatabase): void {
  database.run(
    `CREATE TABLE outbox_jobs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      asset_ref_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      capture_json TEXT NOT NULL CHECK (json_valid(capture_json)),
      state TEXT NOT NULL CHECK (
        state IN ('pending', 'uploading', 'ocr_wait', 'synced', 'blocked', 'failed', 'cancelled')
      ),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      next_retry_at TEXT,
      locked_at TEXT,
      server_capture_id TEXT,
      server_ocr_job_id TEXT,
      last_safe_error_json TEXT,
      terminal_reason TEXT,
      UNIQUE(workspace_id, idempotency_key)
    )`,
  );
}

function createFailingSqliteDatabase(
  database: SqliteDatabase,
  shouldFail: (sql: string) => boolean,
  beforeFailure?: () => void,
): SqliteDatabase {
  let failed = false;

  const failOnce = (sql: string): void => {
    if (failed || !shouldFail(sql)) {
      return;
    }

    failed = true;
    beforeFailure?.();
    throw new Error('injected_sqlite_failure');
  };

  return {
    close: () => database.close(),
    prepare<Row extends SqliteRow = SqliteRow>(sql: string): SqliteStatement<Row> {
      const statement = database.prepare<Row>(sql);
      return {
        all(parameters) {
          return statement.all(parameters);
        },
        get(parameters) {
          return statement.get(parameters);
        },
        run(parameters) {
          failOnce(sql);
          return statement.run(parameters);
        },
      };
    },
    run(sql, parameters) {
      failOnce(sql);
      return database.run(sql, parameters);
    },
  };
}

function createStoredOcrResult(overrides: Partial<StoredOcrResult> = {}): StoredOcrResult {
  return {
    durationMs: 1200,
    qualityFlags: [],
    model: 'test-model',
    providerName: 'test-provider',
    screenText: {
      blocks: [{ kind: 'text', readingOrder: 0, source: 'image_ocr', text: 'hello' }],
      readingOrder: 'top_to_bottom_left_to_right',
      source: 'image_ocr',
    },
    sourceAssetHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    ...overrides,
  };
}

function readOperationalStatistics(database: SqliteDatabase) {
  return database
    .prepare<{
      asset_bytes: number;
      queued_jobs: number;
      retrying_jobs: number;
    }>(
      `SELECT
         asset_bytes,
         queued_jobs,
         retrying_jobs
       FROM operational_store_statistics
       WHERE id = 1`,
    )
    .get();
}

function toOperationalSnapshot(
  row: {
    asset_bytes: number;
    queued_jobs: number;
    retrying_jobs: number;
  } | null,
) {
  if (!row) {
    throw new Error('Expected operational statistics row.');
  }
  return {
    assetBytes: row.asset_bytes,
    queuedJobs: row.queued_jobs,
    retryingJobs: row.retrying_jobs,
  };
}
