import { homedir } from "node:os";
import { ConfigError } from "../utils/errors";
import { engineConfigSchema, type EngineConfig } from "./schema";

function expandTilde(path: string): string {
  if (path.startsWith("~/")) {
    return path.replace("~", homedir());
  }
  return path;
}

function expandConfig(config: EngineConfig): EngineConfig {
  return {
    ...config,
    storage: {
      ...config.storage,
      baseDir: expandTilde(config.storage.baseDir),
    },
    log: {
      ...config.log,
      dir: expandTilde(config.log.dir),
    },
  };
}

function readEnvOverrides(): Record<string, unknown> {
  const env = process.env;
  const overrides: Record<string, unknown> = {};

  if (env.RECAPLY_PORT) overrides.port = Number(env.RECAPLY_PORT);
  if (env.RECAPLY_ENV) overrides.env = env.RECAPLY_ENV;

  const db: Record<string, unknown> = {};
  if (env.RECAPLY_DB_URL) db.url = env.RECAPLY_DB_URL;
  if (env.RECAPLY_DB_NAMESPACE) db.namespace = env.RECAPLY_DB_NAMESPACE;
  if (env.RECAPLY_DB_DATABASE) db.database = env.RECAPLY_DB_DATABASE;
  if (env.RECAPLY_DB_USERNAME) db.username = env.RECAPLY_DB_USERNAME;
  if (env.RECAPLY_DB_PASSWORD) db.password = env.RECAPLY_DB_PASSWORD;
  if (Object.keys(db).length > 0) overrides.db = db;

  const log: Record<string, unknown> = {};
  if (env.RECAPLY_LOG_LEVEL) log.level = env.RECAPLY_LOG_LEVEL;
  if (env.RECAPLY_LOG_DIR) log.dir = env.RECAPLY_LOG_DIR;
  if (Object.keys(log).length > 0) overrides.log = log;

  const storage: Record<string, unknown> = {};
  if (env.RECAPLY_STORAGE_BASE_DIR) storage.baseDir = env.RECAPLY_STORAGE_BASE_DIR;
  if (Object.keys(storage).length > 0) overrides.storage = storage;

  return overrides;
}

export function loadConfig(overrides?: Record<string, unknown>): EngineConfig {
  const envOverrides = readEnvOverrides();
  const merged = { ...envOverrides, ...overrides };

  const result = engineConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`invalid configuration: ${issues}`);
  }

  return expandConfig(result.data);
}

export { engineConfigSchema, type EngineConfig, type DbConfig, type StorageConfig, type LogConfig } from "./schema";
