import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSyncQueueSummary } from '../sync/scheduler';
import { recoverInterruptedOutboxJobs } from '../sync/startup-recovery';
import { createBunSqliteDatabase } from './bun-sqlite-driver';
import {
  type AssetCacheRef,
  type HelperRuntimeState,
  type OutboxJobCreateInput,
  evaluateOperationalStoreBackpressure,
  toRendererSafeAssetRef,
} from './index';
import type { SqliteDatabase } from './sqlite-driver';
import {
  createSqliteOperationalStore,
  runSqliteOperationalStoreMigrations,
} from './sqlite-operational-store';

const now = '2026-07-06T00:00:00.000Z';
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe('SQLite operational store', () => {
  it('records schema version when migrations run repeatedly without clearing data', async () => {
    const database = createBunSqliteDatabase(tempDatabasePath());

    runSqliteOperationalStoreMigrations(database);
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
    runSqliteOperationalStoreMigrations(database);

    expect(
      database.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM schema_migrations').get()
        ?.count,
    ).toBe(1);
    expect(
      database.prepare<{ version: number }>('SELECT version FROM schema_migrations').get(),
    ).toEqual({
      version: 1,
    });
    expect(
      database.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM settings_cache').get()
        ?.count,
    ).toBe(1);

    database.close();
  });

  it('initializes schema idempotently and restores operational state after close and reopen', async () => {
    const path = tempDatabasePath();
    const firstDatabase = createBunSqliteDatabase(path);
    const first = createSqliteOperationalStore({ database: firstDatabase });

    await first.initialize();
    await first.initialize();
    await first.upsertAssetCacheRef(createAsset({ localAccessKey: '/Users/alice/secret.png' }));
    await first.createOutboxJob(createJob());
    await first.setHelperState(createHelperState());
    await first.setPolicyCache({
      actions: ['block_ocr'],
      fetchedAt: now,
      policyVersion: 'policy_v1',
      ttlSeconds: 120,
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
    first.close();

    const reopenedDatabase = createBunSqliteDatabase(path);
    const reopened = createSqliteOperationalStore({ database: reopenedDatabase });
    await reopened.initialize();

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
    expect(await reopened.getHelperState()).toMatchObject({
      helperVersion: 'mock-helper-1.0.0',
      restartCount: 1,
    });
    expect(await reopened.getPolicyCache('workspace_1', { now })).toMatchObject({
      expired: false,
      policyVersion: 'policy_v1',
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
    const first = createSqliteOperationalStore({ database: firstDatabase });

    await first.initialize();
    await first.upsertAssetCacheRef(createAsset());
    await first.createOutboxJob(createJob());
    await first.updateOutboxJobState('job_1', {
      now: '2026-07-06T00:01:00.000Z',
      state: 'uploading',
    });
    await first.createOutboxJob(
      createJob({
        assetRefId: 'asset_2',
        id: 'job_ocr_wait',
        idempotencyKey: 'idem_ocr_wait',
      }),
    );
    await first.updateOutboxJobState('job_ocr_wait', {
      now: '2026-07-06T00:02:00.000Z',
      serverCaptureId: 'capture_ocr_wait',
      serverOcrJobId: 'server_ocr_wait',
      state: 'ocr_wait',
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

    const summary = await recoverInterruptedOutboxJobs({
      now: '2026-07-06T00:10:00.000Z',
      store: first,
    });
    first.close();

    const reopenedDatabase = createBunSqliteDatabase(path);
    const reopened = createSqliteOperationalStore({ database: reopenedDatabase });
    await reopened.initialize();

    expect(summary).toEqual({
      ocrPendingWithoutServerJob: 0,
      ocrPolling: 1,
      recovered: 2,
      scanned: 3,
      unchangedRetryable: 0,
      unchangedTerminal: 1,
      uploadPending: 1,
    });
    expect(await reopened.getOutboxJob('job_1')).toMatchObject({
      lastSafeError: {
        code: 'interrupted_during_upload',
        retryable: true,
      },
      nextRetryAt: '2026-07-06T00:10:00.000Z',
      state: 'pending',
    });
    expect((await reopened.getOutboxJob('job_1'))?.lockedAt).toBeUndefined();
    expect(await reopened.getOutboxJob('job_ocr_wait')).toMatchObject({
      lastSafeError: {
        code: 'interrupted_while_waiting_for_ocr',
        retryable: true,
      },
      serverCaptureId: 'capture_ocr_wait',
      serverOcrJobId: 'server_ocr_wait',
      state: 'pending',
    });
    expect((await reopened.getOutboxJob('job_ocr_wait'))?.lockedAt).toBeUndefined();
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
    const retry = await store.recordOutboxSafeError('job_ready', {
      code: 'provider_unavailable',
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
      reason: 'ocr_succeeded',
      serverCaptureId: 'capture_1',
      serverOcrJobId: 'ocr_1',
      state: 'synced',
    });

    expect(claimed).toMatchObject({
      id: 'job_ready',
      lockedAt: '2026-07-06T00:02:00.000Z',
      state: 'uploading',
    });
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
      state: 'uploading',
    });
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
      serverOcrJobId: 'ocr_late',
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
    expect(stored?.serverOcrJobId).toBeUndefined();
    expect(stored).toMatchObject({
      state: 'cancelled',
      terminalReason: 'user_cancelled',
    });
  });

  it('normalizes CapturePrivacyDecision.decidedAt and persists the normalized payload', async () => {
    const path = tempDatabasePath();
    const database = createBunSqliteDatabase(path);
    const first = createSqliteOperationalStore({ database });
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
    const reopened = createSqliteOperationalStore({ database: reopenedDatabase });
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

  it('rejects invalid JSON text through SQLite CHECK constraints', async () => {
    const database = createBunSqliteDatabase(tempDatabasePath());
    runSqliteOperationalStoreMigrations(database);

    expect(() =>
      database.run(
        `INSERT INTO helper_state (id, state_json, updated_at)
         VALUES ($id, $stateJson, $updatedAt)`,
        {
          $id: 'runtime',
          $stateJson: '{"permissions":',
          $updatedAt: now,
        },
      ),
    ).toThrow(/constraint/i);

    expect(
      database.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM helper_state').get()
        ?.count,
    ).toBe(0);

    database.close();
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
      cleanupState: 'cleanup_pending',
      createdAt: now,
      hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      mimeType: 'image/png',
      role: 'capture_original',
      sizeBytes: 4096,
    });
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('localAccessKey');
    expect(serialized).not.toContain('contentAddress');
  });

  it('expires policy cache entries by TTL and persists sync cursor and settings cache', async () => {
    const store = await createTempStore();
    await store.setPolicyCache({
      actions: ['block_capture', 'redact_context'],
      fetchedAt: '2026-07-06T00:00:00.000Z',
      policyVersion: 'policy_v1',
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
      await store.getPolicyCache('workspace_1', {
        now: '2026-07-06T00:00:30.000Z',
      }),
    ).toMatchObject({
      expired: false,
      policyVersion: 'policy_v1',
    });
    expect(
      await store.getPolicyCache('workspace_1', {
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
    await store.setHelperState(createHelperState());
    await store.setPolicyCache({
      actions: ['block_capture'],
      fetchedAt: now,
      policyVersion: 'policy_v1',
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
    expect(await store.getPolicyCache('workspace_1', { now })).toBeNull();
    expect(await store.getOutboxJob('job_2')).toMatchObject({
      workspaceId: 'workspace_2',
    });
    expect(await store.getAssetCacheRef('asset_2')).toMatchObject({
      workspaceId: 'workspace_2',
    });
    expect(await store.getHelperState()).toMatchObject({
      helperVersion: 'mock-helper-1.0.0',
    });

    await store.clearSignOutCache();

    expect(await store.getOutboxJob('job_2')).toBeNull();
    expect(await store.getAssetCacheRef('asset_2')).toBeNull();
    expect(await store.getSettingsCache('workspace_2')).toBeNull();
    expect(await store.getHelperState()).toBeNull();
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

    const snapshot = await store.getBackpressureSnapshot('workspace_1');
    const backpressure = evaluateOperationalStoreBackpressure(snapshot, {
      maxAssetBytes: 4096,
      maxQueuedJobs: 2,
      maxRetryAttempts: 3,
    });
    const summary = await createSyncQueueSummary(store, 'workspace_1', { backpressure });

    expect(snapshot).toEqual({
      assetBytes: 4096,
      maxAttempt: 1,
      queuedJobs: 2,
    });
    expect(summary).toMatchObject({
      backpressure: {
        active: true,
        reasons: ['max_queued_jobs_reached', 'max_asset_bytes_reached'],
      },
      pending: 2,
      retrying: 1,
    });
  });
});

async function createTempStore(): Promise<ReturnType<typeof createSqliteOperationalStore>> {
  const { store } = await createTempStoreWithDatabase();
  return store;
}

async function createTempStoreWithDatabase(): Promise<{
  database: SqliteDatabase;
  store: ReturnType<typeof createSqliteOperationalStore>;
}> {
  const database = createBunSqliteDatabase(tempDatabasePath());
  const store = createSqliteOperationalStore({ database });
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

function createHelperState(overrides: Partial<HelperRuntimeState> = {}): HelperRuntimeState {
  return {
    helperVersion: 'mock-helper-1.0.0',
    lastHeartbeatAt: now,
    permissions: {
      accessibility: 'unknown',
      screenRecording: 'granted',
    },
    pidDigest: 'pid:123',
    restartCount: 1,
    transport: 'stdio_ndjson',
    updatedAt: now,
    ...overrides,
  };
}
