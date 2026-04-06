import { z } from "zod/v4";

export const dbConfigSchema = z.object({
  url: z.string().default("ws://127.0.0.1:21890"),
  namespace: z.string().default("recaply"),
  database: z.string().default("sense"),
  username: z.string().default("root"),
  password: z.string().default("root"),
});

export const storageConfigSchema = z.object({
  baseDir: z.string().default("~/Library/Application Support/RecaplySense"),
  screenshotsDir: z.string().default("screenshots"),
  thumbnailsDir: z.string().default("thumbnails"),
});

export const logConfigSchema = z.object({
  level: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  dir: z.string().default("~/Library/Application Support/RecaplySense/logs"),
});

export const engineConfigSchema = z.object({
  port: z.number().default(21890),
  env: z.enum(["development", "production", "test"]).default("development"),
  db: dbConfigSchema.default(() => dbConfigSchema.parse({})),
  storage: storageConfigSchema.default(() => storageConfigSchema.parse({})),
  log: logConfigSchema.default(() => logConfigSchema.parse({})),
});

export type EngineConfig = z.infer<typeof engineConfigSchema>;
export type DbConfig = z.infer<typeof dbConfigSchema>;
export type StorageConfig = z.infer<typeof storageConfigSchema>;
export type LogConfig = z.infer<typeof logConfigSchema>;
