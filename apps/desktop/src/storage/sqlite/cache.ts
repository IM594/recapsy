import {
  cloneLocalCapturePolicyRule,
  clonePolicyCache,
  cloneSettingsCache,
  cloneSyncCursor,
} from '../cache-values';
import type {
  LocalCapturePolicyRule,
  PolicyCacheEntry,
  PolicyCacheRead,
  PolicyCacheReadOptions,
  SettingsCache,
  SyncCursor,
  SyncCursorKind,
} from '../types';
import type { SqliteDatabase, SqliteRow } from './driver';
import { parseJson } from './serialization';

export class SqliteCachePersistence {
  constructor(private readonly database: SqliteDatabase) {}

  async setPolicyCache(entry: PolicyCacheEntry): Promise<PolicyCacheEntry> {
    const cloned = clonePolicyCache(entry);
    this.database
      .prepare(
        `INSERT INTO policy_cache (
          workspace_id,
          device_id,
          policy_snapshot_id,
          policy_version,
          policy_json,
          fetched_at,
          ttl_seconds,
          max_concurrent_ocr
        ) VALUES (
          $workspaceId,
          $deviceId,
          $policySnapshotId,
          $policyVersion,
          $policyJson,
          $fetchedAt,
          $ttlSeconds,
          $maxConcurrentOcr
        )
        ON CONFLICT(workspace_id, device_id) DO UPDATE SET
          policy_snapshot_id = excluded.policy_snapshot_id,
          policy_version = excluded.policy_version,
          policy_json = excluded.policy_json,
          fetched_at = excluded.fetched_at,
          ttl_seconds = excluded.ttl_seconds,
          max_concurrent_ocr = excluded.max_concurrent_ocr`,
      )
      .run({
        $deviceId: cloned.deviceId,
        $fetchedAt: cloned.fetchedAt,
        $policyJson: JSON.stringify(cloned.policy),
        $policySnapshotId: cloned.policySnapshotId,
        $policyVersion: cloned.policyVersion,
        $ttlSeconds: cloned.ttlSeconds,
        $maxConcurrentOcr: cloned.maxConcurrentOcr ?? 1,
        $workspaceId: cloned.workspaceId,
      });

    return clonePolicyCache(cloned);
  }

  async getPolicyCache(
    workspaceId: string,
    deviceId: string,
    options: PolicyCacheReadOptions,
  ): Promise<PolicyCacheRead | null> {
    const row = this.database
      .prepare<PolicyCacheRow>(
        `SELECT *
         FROM policy_cache
         WHERE workspace_id = $workspaceId AND device_id = $deviceId
         LIMIT 1`,
      )
      .get({ $deviceId: deviceId, $workspaceId: workspaceId });

    if (!row) {
      return null;
    }

    const entry = policyCacheFromRow(row);
    return {
      ...entry,
      expired: isExpired(entry.fetchedAt, entry.ttlSeconds, options.now),
    };
  }

  async upsertLocalCapturePolicyRule(
    rule: LocalCapturePolicyRule,
  ): Promise<LocalCapturePolicyRule> {
    const cloned = cloneLocalCapturePolicyRule(rule);
    this.database
      .prepare(
        `INSERT INTO local_capture_policy_rules (
          id, kind, pattern, action, enabled, reason, created_at, updated_at
        ) VALUES (
          $id, $kind, $pattern, $action, $enabled, $reason, $createdAt, $updatedAt
        )
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          pattern = excluded.pattern,
          action = excluded.action,
          enabled = excluded.enabled,
          reason = excluded.reason,
          updated_at = excluded.updated_at`,
      )
      .run({
        $action: cloned.action,
        $createdAt: cloned.createdAt,
        $enabled: cloned.enabled ? 1 : 0,
        $id: cloned.id,
        $kind: cloned.kind,
        $pattern: cloned.pattern,
        $reason: cloned.reason ?? null,
        $updatedAt: cloned.updatedAt,
      });
    return cloneLocalCapturePolicyRule(cloned);
  }

  async listLocalCapturePolicyRules(): Promise<LocalCapturePolicyRule[]> {
    return this.database
      .prepare<LocalCapturePolicyRuleRow>(
        `SELECT *
         FROM local_capture_policy_rules
         ORDER BY pattern ASC, id ASC`,
      )
      .all()
      .map(localCapturePolicyRuleFromRow);
  }

  async deleteLocalCapturePolicyRule(id: string): Promise<boolean> {
    return (
      this.database
        .prepare('DELETE FROM local_capture_policy_rules WHERE id = $id')
        .run({ $id: id }).changes > 0
    );
  }

  async setSyncCursor(cursor: SyncCursor): Promise<SyncCursor> {
    const cloned = cloneSyncCursor(cursor);
    this.database
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
    const row = this.database
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
    this.database
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
    const row = this.database
      .prepare<SettingsCacheRow>(
        `SELECT *
         FROM settings_cache
         WHERE workspace_id = $workspaceId
         LIMIT 1`,
      )
      .get({ $workspaceId: workspaceId });

    return row ? settingsCacheFromRow(row) : null;
  }
}

type PolicyCacheRow = SqliteRow & {
  workspace_id: string;
  device_id: string;
  policy_snapshot_id: string;
  policy_version: string;
  policy_json: string;
  fetched_at: string;
  ttl_seconds: number;
  max_concurrent_ocr: number;
};

type LocalCapturePolicyRuleRow = SqliteRow & {
  id: string;
  kind: 'bundle_id' | 'domain' | 'domain_family';
  pattern: string;
  action: 'block_capture';
  enabled: number;
  reason?: string | null;
  created_at: string;
  updated_at: string;
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

function policyCacheFromRow(row: PolicyCacheRow): PolicyCacheEntry {
  return clonePolicyCache({
    deviceId: row.device_id,
    fetchedAt: row.fetched_at,
    policy: parseJson<PolicyCacheEntry['policy']>(row.policy_json),
    policySnapshotId: row.policy_snapshot_id,
    policyVersion: row.policy_version,
    ttlSeconds: row.ttl_seconds,
    maxConcurrentOcr: row.max_concurrent_ocr,
    workspaceId: row.workspace_id,
  });
}

function localCapturePolicyRuleFromRow(row: LocalCapturePolicyRuleRow): LocalCapturePolicyRule {
  return {
    action: 'block_capture',
    createdAt: row.created_at,
    enabled: row.enabled === 1,
    id: row.id,
    kind: row.kind,
    pattern: row.pattern,
    scope: 'local_user',
    updatedAt: row.updated_at,
    ...(row.reason ? { reason: row.reason } : {}),
  };
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

function isExpired(fetchedAt: string, ttlSeconds: number, now: string): boolean {
  return Date.parse(now) > Date.parse(fetchedAt) + ttlSeconds * 1000;
}
