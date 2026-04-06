import type { Surreal } from "surrealdb";
import type { Logger } from "../../utils/logger";
import { MigrationError } from "../../utils/errors";

export interface Migration {
  version: number;
  name: string;
  up(db: Surreal): Promise<void>;
}

export interface MigrationRunnerDeps {
  db: Surreal;
  logger: Logger;
  migrations: Migration[];
}

export interface MigrationRunner {
  run(): Promise<void>;
  getAppliedVersions(): Promise<number[]>;
}

const INIT_MIGRATION_TABLE = `
DEFINE TABLE IF NOT EXISTS migration_history SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS version ON migration_history TYPE int;
DEFINE FIELD IF NOT EXISTS name ON migration_history TYPE string;
DEFINE FIELD IF NOT EXISTS applied_at ON migration_history TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS duration_ms ON migration_history TYPE int;
DEFINE INDEX IF NOT EXISTS idx_mh_version ON migration_history FIELDS version UNIQUE;
`;

export function createMigrationRunner(deps: MigrationRunnerDeps): MigrationRunner {
  const { db, logger: parentLogger, migrations } = deps;
  const logger = parentLogger.child({ module: "migration" });

  return {
    async run() {
      // Ensure migration_history table exists
      await db.query(INIT_MIGRATION_TABLE);

      const applied = await this.getAppliedVersions();
      const sorted = [...migrations].sort((a, b) => a.version - b.version);
      const pending = sorted.filter((m) => !applied.includes(m.version));

      if (pending.length === 0) {
        logger.info("no pending migrations");
        return;
      }

      logger.info({ count: pending.length }, "running pending migrations");

      for (const migration of pending) {
        const start = performance.now();
        try {
          await migration.up(db);
          const durationMs = Math.round(performance.now() - start);

          await db.query(
            "CREATE migration_history SET version = $version, name = $name, duration_ms = $durationMs",
            { version: migration.version, name: migration.name, durationMs },
          );

          logger.info(
            { version: migration.version, name: migration.name, durationMs },
            "migration applied",
          );
        } catch (error) {
          logger.error(
            { version: migration.version, name: migration.name, error },
            "migration failed",
          );
          throw new MigrationError(
            `migration ${migration.version} (${migration.name}) failed`,
            error,
          );
        }
      }
    },

    async getAppliedVersions() {
      const result = await db.query<[Array<{ version: number }>]>(
        "SELECT version FROM migration_history ORDER BY version ASC",
      );
      return (result[0] ?? []).map((r) => r.version);
    },
  };
}
