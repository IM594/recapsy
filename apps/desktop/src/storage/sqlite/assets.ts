import { cloneAssetRef } from '../asset-values';
import type {
  AssetCacheRef,
  ClaimAssetCleanupInput,
  OperationalStoreResult,
  RecoverPendingAssetCleanupInput,
  SetAssetCleanupStateInput,
  UpdateAssetRefAvailabilityInput,
} from '../types';
import type { SqliteDatabase, SqliteRow } from './driver';
import { parseJson } from './serialization';

export class SqliteAssetPersistence {
  constructor(private readonly database: SqliteDatabase) {}

  async upsert(asset: AssetCacheRef): Promise<AssetCacheRef> {
    const cloned = cloneAssetRef(asset);
    this.insert(cloned);
    return cloneAssetRef(cloned);
  }

  async get(assetRefId: string): Promise<AssetCacheRef | null> {
    return this.read(assetRefId);
  }

  async list(workspaceId?: string): Promise<AssetCacheRef[]> {
    const rows = workspaceId
      ? this.database
          .prepare<AssetCacheRefRow>(
            `SELECT *
             FROM asset_cache_refs
             WHERE workspace_id = $workspaceId
             ORDER BY created_at ASC, asset_ref_id ASC`,
          )
          .all({ $workspaceId: workspaceId })
      : this.database
          .prepare<AssetCacheRefRow>(
            'SELECT * FROM asset_cache_refs ORDER BY workspace_id ASC, created_at ASC, asset_ref_id ASC',
          )
          .all();

    return rows.map(assetRefFromRow);
  }

  async listByIds(assetRefIds: readonly string[]): Promise<AssetCacheRef[]> {
    if (assetRefIds.length === 0) {
      return [];
    }

    const parameters: Record<string, string> = {};
    const placeholders = assetRefIds.map((assetRefId, index) => {
      const parameter = `$assetRefId${index}`;
      parameters[parameter] = assetRefId;
      return parameter;
    });
    const rows = this.database
      .prepare<AssetCacheRefRow>(
        `SELECT *
         FROM asset_cache_refs
         WHERE asset_ref_id IN (${placeholders.join(', ')})`,
      )
      .all(parameters);

    return rows.map(assetRefFromRow);
  }

  async listPage(input: {
    afterAssetRefId?: string;
    excludedAssetRefIds: readonly string[];
    limit: number;
    workspaceId?: string;
  }): Promise<AssetCacheRef[]> {
    const parameters: Record<string, string | number> = { $limit: input.limit };
    const conditions: string[] = [];

    if (input.workspaceId) {
      conditions.push('workspace_id = $workspaceId');
      parameters.$workspaceId = input.workspaceId;
    }
    if (input.afterAssetRefId) {
      conditions.push('asset_ref_id > $afterAssetRefId');
      parameters.$afterAssetRefId = input.afterAssetRefId;
    }
    if (input.excludedAssetRefIds.length > 0) {
      const placeholders = input.excludedAssetRefIds.map((assetRefId, index) => {
        const parameter = `$excludedAssetRefId${index}`;
        parameters[parameter] = assetRefId;
        return parameter;
      });
      conditions.push(`asset_ref_id NOT IN (${placeholders.join(', ')})`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.database
      .prepare<AssetCacheRefRow>(
        `SELECT *
         FROM asset_cache_refs
         ${where}
         ORDER BY asset_ref_id ASC
         LIMIT $limit`,
      )
      .all(parameters);

    return rows.map(assetRefFromRow);
  }

  async updateAvailability(
    input: UpdateAssetRefAvailabilityInput,
  ): Promise<OperationalStoreResult<AssetCacheRef>> {
    const row = this.database
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

    return row
      ? { ok: true, value: assetRefFromRow(row) }
      : {
          error: { code: 'asset_ref_not_found', message: 'Asset ref was not found.' },
          ok: false,
        };
  }

  async claimCleanup(input: ClaimAssetCleanupInput): Promise<AssetCacheRef | null> {
    const row = this.database
      .prepare<AssetCacheRefRow>(
        `UPDATE asset_cache_refs
         SET cleanup_state = 'cleanup_pending',
             cleanup_updated_at = $now,
             cleanup_safe_error_json = NULL
         WHERE asset_ref_id = $assetRefId
           AND cleanup_state IN ('retained', 'cleanup_failed')
         RETURNING *`,
      )
      .get({ $assetRefId: input.assetRefId, $now: input.now });

    return row ? assetRefFromRow(row) : null;
  }

  async settleCleanup(
    input: SetAssetCleanupStateInput,
  ): Promise<OperationalStoreResult<AssetCacheRef>> {
    const row = this.database
      .prepare<AssetCacheRefRow>(
        `UPDATE asset_cache_refs
         SET cleanup_state = $cleanupState,
             cleanup_updated_at = $now,
             cleanup_safe_error_json = $cleanupSafeErrorJson,
             availability_state = CASE
               WHEN $cleanupState = 'cleaned' THEN 'missing'
               ELSE availability_state
             END,
             availability_checked_at = CASE
               WHEN $cleanupState = 'cleaned' THEN $now
               ELSE availability_checked_at
             END,
             availability_safe_error_json = CASE
               WHEN $cleanupState = 'cleaned' THEN NULL
               ELSE availability_safe_error_json
             END
         WHERE asset_ref_id = $assetRefId
           AND cleanup_state = 'cleanup_pending'
         RETURNING *`,
      )
      .get({
        $assetRefId: input.assetRefId,
        $cleanupSafeErrorJson: input.cleanupSafeError
          ? JSON.stringify(input.cleanupSafeError)
          : null,
        $cleanupState: input.cleanupState,
        $now: input.now,
      });

    return row
      ? { ok: true, value: assetRefFromRow(row) }
      : {
          error: {
            code: 'asset_cleanup_conflict',
            message: 'Asset cleanup is no longer pending.',
          },
          ok: false,
        };
  }

  async recoverPendingCleanup(input: RecoverPendingAssetCleanupInput): Promise<number> {
    const pending =
      this.database
        .prepare<{ count: number }>(
          `SELECT COUNT(*) AS count
         FROM asset_cache_refs
         WHERE workspace_id = $workspaceId
           AND cleanup_state = 'cleanup_pending'`,
        )
        .get({ $workspaceId: input.workspaceId })?.count ?? 0;

    if (pending === 0) {
      return 0;
    }

    this.database
      .prepare(
        `UPDATE asset_cache_refs
         SET cleanup_state = 'cleanup_failed',
             cleanup_updated_at = $now,
             cleanup_safe_error_json = $cleanupSafeErrorJson
         WHERE workspace_id = $workspaceId
           AND cleanup_state = 'cleanup_pending'`,
      )
      .run({
        $cleanupSafeErrorJson: JSON.stringify({
          code: 'local_asset_cleanup_interrupted',
          message: 'Local asset cleanup was interrupted.',
          retryable: true,
        }),
        $now: input.now,
        $workspaceId: input.workspaceId,
      });
    return pending;
  }

  async delete(assetRefId: string): Promise<boolean> {
    const result = this.database
      .prepare(
        `DELETE FROM asset_cache_refs
         WHERE asset_ref_id = $assetRefId`,
      )
      .run({ $assetRefId: assetRefId });

    return result.changes > 0;
  }

  read(assetRefId: string): AssetCacheRef | null {
    const row = this.database
      .prepare<AssetCacheRefRow>(
        `SELECT *
         FROM asset_cache_refs
         WHERE asset_ref_id = $assetRefId
         LIMIT 1`,
      )
      .get({ $assetRefId: assetRefId });

    return row ? assetRefFromRow(row) : null;
  }

  insert(asset: AssetCacheRef): void {
    const cloned = cloneAssetRef(asset);
    this.database
      .prepare(
        `INSERT INTO asset_cache_refs (
          asset_ref_id,
          workspace_id,
          role,
          hash,
          mime_type,
          size_bytes,
          cleanup_state,
          cleanup_updated_at,
          cleanup_safe_error_json,
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
          $cleanupUpdatedAt,
          $cleanupSafeErrorJson,
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
          cleanup_updated_at = excluded.cleanup_updated_at,
          cleanup_safe_error_json = excluded.cleanup_safe_error_json,
          availability_state = excluded.availability_state,
          availability_checked_at = excluded.availability_checked_at,
          created_at = excluded.created_at,
          local_access_key = excluded.local_access_key,
          availability_safe_error_json = excluded.availability_safe_error_json,
          content_address = excluded.content_address`,
      )
      .run(assetParameters(cloned));
  }
}

type AssetCacheRefRow = SqliteRow & {
  asset_ref_id: string;
  workspace_id: string;
  role: AssetCacheRef['role'];
  hash: string;
  mime_type: string;
  size_bytes: number;
  cleanup_state: AssetCacheRef['cleanupState'];
  cleanup_updated_at?: string | null;
  cleanup_safe_error_json?: string | null;
  availability_state: AssetCacheRef['availabilityState'];
  availability_checked_at?: string | null;
  created_at: string;
  local_access_key: string;
  availability_safe_error_json?: string | null;
  content_address?: string | null;
};

function assetParameters(asset: AssetCacheRef): Record<string, string | number | null> {
  return {
    $assetRefId: asset.assetRefId,
    $availabilityCheckedAt: asset.availabilityCheckedAt ?? null,
    $availabilitySafeErrorJson: asset.availabilitySafeError
      ? JSON.stringify(asset.availabilitySafeError)
      : null,
    $availabilityState: asset.availabilityState,
    $cleanupSafeErrorJson: asset.cleanupSafeError ? JSON.stringify(asset.cleanupSafeError) : null,
    $cleanupState: asset.cleanupState,
    $cleanupUpdatedAt: asset.cleanupUpdatedAt ?? null,
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
    ...(row.cleanup_updated_at ? { cleanupUpdatedAt: row.cleanup_updated_at } : {}),
    ...(row.content_address ? { contentAddress: row.content_address } : {}),
    ...(row.availability_safe_error_json
      ? {
          availabilitySafeError: parseJson<AssetCacheRef['availabilitySafeError']>(
            row.availability_safe_error_json,
          ),
        }
      : {}),
    ...(row.cleanup_safe_error_json
      ? {
          cleanupSafeError: parseJson<AssetCacheRef['cleanupSafeError']>(
            row.cleanup_safe_error_json,
          ),
        }
      : {}),
  });
}

export { assetRefMatches } from '../asset-values';
