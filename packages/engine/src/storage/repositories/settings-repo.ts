import type { Surreal } from "surrealdb";
import { settingsSchema, type Settings } from "@recaply/shared";
import type { Logger } from "../../utils/logger";
import { StorageError } from "../../utils/errors";
import { normalizeRow } from "../utils";

export interface SettingsRepo {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
  getAll(): Promise<Settings[]>;
  delete(key: string): Promise<void>;
}

export interface SettingsRepoDeps {
  db: Surreal;
  logger: Logger;
}

export function createSettingsRepo(deps: SettingsRepoDeps): SettingsRepo {
  const { db, logger: parentLogger } = deps;
  const logger = parentLogger.child({ module: "settings-repo" });

  function parseRow(row: unknown): Settings {
    const normalized = normalizeRow(row as Record<string, unknown>);
    const result = settingsSchema.safeParse(normalized);
    if (!result.success) {
      logger.warn({ error: result.error, row }, "failed to parse settings row");
      throw new StorageError("invalid settings data from database");
    }
    return result.data;
  }

  return {
    async get(key) {
      try {
        const [rows] = await db.query<[Settings[]]>(
          "SELECT * FROM settings WHERE key = $key LIMIT 1",
          { key },
        );
        const row = rows?.[0];
        if (!row) return undefined;
        return parseRow(row).value;
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw new StorageError(`failed to get setting: ${key}`, error);
      }
    },

    async set(key, value) {
      try {
        // Use INSERT with ON DUPLICATE KEY UPDATE to avoid TOCTOU race
        // The UNIQUE index on `key` triggers the conflict handling
        await db.query(
          `INSERT INTO settings { key: $key, value: $value }
           ON DUPLICATE KEY UPDATE value = $value, updated_at = time::now()`,
          { key, value },
        );
        logger.debug({ key }, "setting saved");
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw new StorageError(`failed to set setting: ${key}`, error);
      }
    },

    async getAll() {
      try {
        const [rows] = await db.query<[Settings[]]>(
          "SELECT * FROM settings ORDER BY key ASC",
        );
        if (!Array.isArray(rows)) return [];
        return rows.map(parseRow);
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw new StorageError("failed to get all settings", error);
      }
    },

    async delete(key) {
      try {
        await db.query("DELETE FROM settings WHERE key = $key", { key });
        logger.debug({ key }, "setting deleted");
      } catch (error) {
        throw new StorageError(`failed to delete setting: ${key}`, error);
      }
    },
  };
}
