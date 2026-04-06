import { Surreal } from "surrealdb";
import type { DbConfig } from "../config/schema";
import type { Logger } from "../utils/logger";
import { StorageError } from "../utils/errors";

export interface DatabaseDeps {
  config: DbConfig;
  logger: Logger;
}

export interface Database {
  readonly client: Surreal;
  connect(): Promise<void>;
  healthCheck(): Promise<boolean>;
  close(): Promise<void>;
}

export function createDatabase(deps: DatabaseDeps): Database {
  const { config, logger: parentLogger } = deps;
  const logger = parentLogger.child({ module: "storage" });
  const client = new Surreal();

  return {
    client,

    async connect() {
      try {
        await client.connect(config.url);
        await client.signin({ username: config.username, password: config.password });
        await client.use({ namespace: config.namespace, database: config.database });
        logger.info(
          { url: config.url, namespace: config.namespace, database: config.database },
          "database connected",
        );
      } catch (error) {
        throw new StorageError(`failed to connect to SurrealDB at ${config.url}`, error);
      }
    },

    async healthCheck() {
      try {
        const result = await client.query<[boolean]>("RETURN true");
        return result[0] === true;
      } catch {
        return false;
      }
    },

    async close() {
      try {
        await client.close();
        logger.info("database connection closed");
      } catch (error) {
        logger.warn({ error }, "error closing database connection");
      }
    },
  };
}
