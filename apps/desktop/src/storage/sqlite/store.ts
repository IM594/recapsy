import { settleServerCapture as settleStoredServerCapture } from '../reconciliation';
import type {
  AssetCacheRef,
  CaptureOutboxEntryCreateInput,
  ClaimAssetCleanupInput,
  ClaimRetryableOutboxJobInput,
  LocalCapturePolicyRule,
  OperationalStoreError,
  OperationalStoreResult,
  OperationalStoreSnapshot,
  OutboxJob,
  OutboxJobCreateInput,
  OutboxJobListFilter,
  OutboxJobStateUpdate,
  OutboxSafeErrorInput,
  OutboxTerminalUpdate,
  PolicyCacheEntry,
  PolicyCacheRead,
  PolicyCacheReadOptions,
  RecoverInterruptedOutboxJobInput,
  RecoverPendingAssetCleanupInput,
  ServerCaptureSettlement,
  ServerCaptureSettlementInput,
  SetAssetCleanupStateInput,
  SettingsCache,
  SyncCursor,
  SyncCursorKind,
  UpdateAssetRefAvailabilityInput,
} from '../types';
import { SqliteAssetPersistence, assetRefMatches } from './assets';
import { SqliteCachePersistence } from './cache';
import type { SqliteDatabase } from './driver';
import { migrateSqliteStore } from './migrations';
import {
  SqliteOutboxPersistence,
  cloneOutboxJob,
  createPendingOutboxJob,
  mapCreateOutboxConstraintError,
  outboxJobMatchesInput,
} from './outbox';

export type SqliteStoreOptions = {
  database: SqliteDatabase;
  maxActiveOutboxJobs?: number;
};

export function createSqliteStore(options: SqliteStoreOptions) {
  return new SqliteOperationalStore(options);
}

class SqliteOperationalStore {
  private readonly assets: SqliteAssetPersistence;
  private readonly cache: SqliteCachePersistence;
  private readonly outbox: SqliteOutboxPersistence;

  constructor(private readonly options: SqliteStoreOptions) {
    this.assets = new SqliteAssetPersistence(options.database);
    this.cache = new SqliteCachePersistence(options.database);
    this.outbox = new SqliteOutboxPersistence(options.database, options.maxActiveOutboxJobs);
  }

  async initialize(): Promise<void> {
    migrateSqliteStore(this.options.database);
  }

  close(): void {
    this.options.database.close();
  }

  createOutboxJob(job: OutboxJobCreateInput): Promise<OperationalStoreResult<OutboxJob>> {
    return this.outbox.create(job);
  }

  async createCaptureOutboxEntry(
    entry: CaptureOutboxEntryCreateInput,
  ): Promise<OperationalStoreResult<OutboxJob>> {
    let transactionOpen = false;

    try {
      this.options.database.run('BEGIN IMMEDIATE');
      transactionOpen = true;

      const conflict = this.outbox.findByIdempotencyKey(entry.workspaceId, entry.idempotencyKey);
      if (conflict) {
        const matches =
          outboxJobMatchesInput(conflict, entry) &&
          entry.assetRefs.every((assetRef) => {
            const existing = this.assets.read(assetRef.assetRefId);
            return existing ? assetRefMatches(existing, assetRef) : false;
          });

        this.options.database.run('ROLLBACK');
        transactionOpen = false;
        return matches
          ? success(conflict)
          : failure({
              code: 'idempotency_key_conflict',
              message: 'Outbox idempotency key already exists for this workspace.',
            });
      }

      if (this.outbox.capacityReached()) {
        this.options.database.run('ROLLBACK');
        transactionOpen = false;
        return failure({
          code: 'capacity_exceeded',
          message: 'Outbox active job capacity has been reached.',
        });
      }

      if (this.outbox.hasId(entry.id)) {
        this.options.database.run('ROLLBACK');
        transactionOpen = false;
        return failure({
          code: 'outbox_job_id_conflict',
          message: 'Outbox job id already exists.',
        });
      }

      for (const assetRef of entry.assetRefs) {
        const existing = this.assets.read(assetRef.assetRefId);
        if (existing && !assetRefMatches(existing, assetRef)) {
          this.options.database.run('ROLLBACK');
          transactionOpen = false;
          return failure({
            code: 'asset_ref_conflict',
            message: 'Asset ref already exists with different metadata.',
          });
        }
      }

      const created = createPendingOutboxJob(entry);
      for (const assetRef of entry.assetRefs) this.assets.insert(assetRef);
      this.outbox.insert(created);

      this.options.database.run('COMMIT');
      transactionOpen = false;
      return success(cloneOutboxJob(created));
    } catch (error) {
      if (transactionOpen) this.options.database.run('ROLLBACK');
      const mapped = mapCreateOutboxConstraintError(error);
      if (mapped) return failure(mapped);
      throw error;
    }
  }

  getOutboxJob(id: string): Promise<OutboxJob | null> {
    return this.outbox.get(id);
  }

  listOutboxJobs(filter: OutboxJobListFilter = {}): Promise<OutboxJob[]> {
    return this.outbox.list(filter);
  }

  updateOutboxJobState(
    id: string,
    update: OutboxJobStateUpdate,
  ): Promise<OperationalStoreResult<OutboxJob>> {
    return this.outbox.updateState(id, update);
  }

  claimNextRetryableOutboxJob(input: ClaimRetryableOutboxJobInput): Promise<OutboxJob | null> {
    return this.outbox.claimNextRetryable(input);
  }

  markOutboxJobTerminal(
    id: string,
    update: OutboxTerminalUpdate,
  ): Promise<OperationalStoreResult<OutboxJob>> {
    return this.outbox.markTerminal(id, update);
  }

  settleServerCapture(input: ServerCaptureSettlementInput): Promise<ServerCaptureSettlement> {
    return settleStoredServerCapture(this, input);
  }

  recordOutboxSafeError(
    id: string,
    input: OutboxSafeErrorInput,
  ): Promise<OperationalStoreResult<OutboxJob>> {
    return this.outbox.recordSafeError(id, input);
  }

  recoverInterruptedOutboxJob(
    input: RecoverInterruptedOutboxJobInput,
  ): Promise<OperationalStoreResult<OutboxJob>> {
    return this.outbox.recoverInterrupted(input);
  }

  upsertAssetCacheRef(asset: AssetCacheRef): Promise<AssetCacheRef> {
    return this.assets.upsert(asset);
  }

  getAssetCacheRef(assetRefId: string): Promise<AssetCacheRef | null> {
    return this.assets.get(assetRefId);
  }

  listAssetCacheRefs(workspaceId?: string): Promise<AssetCacheRef[]> {
    return this.assets.list(workspaceId);
  }

  updateAssetRefAvailability(
    input: UpdateAssetRefAvailabilityInput,
  ): Promise<OperationalStoreResult<AssetCacheRef>> {
    return this.assets.updateAvailability(input);
  }

  claimAssetCleanup(input: ClaimAssetCleanupInput): Promise<AssetCacheRef | null> {
    return this.assets.claimCleanup(input);
  }

  settleAssetCleanup(
    input: SetAssetCleanupStateInput,
  ): Promise<OperationalStoreResult<AssetCacheRef>> {
    return this.assets.settleCleanup(input);
  }

  recoverPendingAssetCleanup(input: RecoverPendingAssetCleanupInput): Promise<number> {
    return this.assets.recoverPendingCleanup(input);
  }

  deleteAssetCacheRef(assetRefId: string): Promise<boolean> {
    return this.assets.delete(assetRefId);
  }

  setPolicyCache(entry: PolicyCacheEntry): Promise<PolicyCacheEntry> {
    return this.cache.setPolicyCache(entry);
  }

  getPolicyCache(
    workspaceId: string,
    deviceId: string,
    options: PolicyCacheReadOptions,
  ): Promise<PolicyCacheRead | null> {
    return this.cache.getPolicyCache(workspaceId, deviceId, options);
  }

  upsertLocalCapturePolicyRule(rule: LocalCapturePolicyRule): Promise<LocalCapturePolicyRule> {
    return this.cache.upsertLocalCapturePolicyRule(rule);
  }

  listLocalCapturePolicyRules(): Promise<LocalCapturePolicyRule[]> {
    return this.cache.listLocalCapturePolicyRules();
  }

  deleteLocalCapturePolicyRule(id: string): Promise<boolean> {
    return this.cache.deleteLocalCapturePolicyRule(id);
  }

  setSyncCursor(cursor: SyncCursor): Promise<SyncCursor> {
    return this.cache.setSyncCursor(cursor);
  }

  getSyncCursor(workspaceId: string, kind: SyncCursorKind): Promise<SyncCursor | null> {
    return this.cache.getSyncCursor(workspaceId, kind);
  }

  setSettingsCache(settings: SettingsCache): Promise<SettingsCache> {
    return this.cache.setSettingsCache(settings);
  }

  getSettingsCache(workspaceId: string): Promise<SettingsCache | null> {
    return this.cache.getSettingsCache(workspaceId);
  }

  async getBackpressureSnapshot(): Promise<OperationalStoreSnapshot> {
    const jobRow = this.options.database
      .prepare<{ queued_jobs: number; retrying_jobs: number }>(
        `SELECT
           SUM(CASE WHEN state NOT IN ('synced', 'blocked', 'failed', 'cancelled') THEN 1 ELSE 0 END)
             AS queued_jobs,
           SUM(CASE WHEN state = 'pending' AND next_retry_at IS NOT NULL THEN 1 ELSE 0 END)
             AS retrying_jobs
         FROM outbox_jobs`,
      )
      .get();
    const assetRow = this.options.database
      .prepare<{ asset_bytes: number | null }>(
        `SELECT SUM(size_bytes) AS asset_bytes
         FROM asset_cache_refs
         WHERE cleanup_state != 'cleaned'`,
      )
      .get();

    return {
      assetBytes: assetRow?.asset_bytes ?? 0,
      queuedJobs: jobRow?.queued_jobs ?? 0,
      retryingJobs: jobRow?.retrying_jobs ?? 0,
    };
  }

  async verifyOperationalWrite(): Promise<void> {
    let transactionOpen = false;

    try {
      this.options.database.run('BEGIN IMMEDIATE');
      transactionOpen = true;
      this.options.database.run(
        `INSERT INTO operational_health_probe (id, generation, updated_at)
         VALUES (1, 1, $updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           generation = operational_health_probe.generation + 1,
           updated_at = excluded.updated_at`,
        { $updatedAt: new Date().toISOString() },
      );
      this.options.database.run('COMMIT');
      transactionOpen = false;
    } catch {
      if (transactionOpen) {
        try {
          this.options.database.run('ROLLBACK');
        } catch {
          // The failed transaction remains fail-closed even if rollback is unavailable.
        }
      }
      throw new Error('operational_write_verification_failed');
    }
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
  }
}

function success<T>(value: T): OperationalStoreResult<T> {
  return { ok: true, value };
}

function failure<T>(error: OperationalStoreError): OperationalStoreResult<T> {
  return { error, ok: false };
}
