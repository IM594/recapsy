import { loadConfig } from "./config";
import { createRootLogger } from "./utils/logger";
import { createDatabase } from "./storage/database";
import { createMigrationRunner, allMigrations } from "./storage/migrations";
import { createEventBus } from "./events/bus";

async function main() {
  const config = loadConfig();
  const logger = createRootLogger({ level: config.log.level, env: config.env });
  const eventBus = createEventBus();

  logger.info({ env: config.env, port: config.port }, "starting engine");

  // Database
  const database = createDatabase({ config: config.db, logger });
  await database.connect();
  eventBus.emit("db:connected", { url: config.db.url });

  // Migrations
  const migrationRunner = createMigrationRunner({
    db: database.client,
    logger,
    migrations: allMigrations,
  });
  await migrationRunner.run();

  // Health check
  const healthy = await database.healthCheck();
  if (!healthy) {
    logger.error("database health check failed after migration");
    process.exit(1);
  }

  logger.info("Engine ready");

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("shutting down...");
    await database.close();
    eventBus.emit("db:disconnected", { reason: "shutdown" });
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("fatal:", error);
  process.exit(1);
});
