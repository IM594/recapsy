import fs from "fs";
import path from "path";
import dotenv from "dotenv";

import logger from "../lib/logger";
import { DEFAULTS, ENV_KEYS } from "./constants";
import type { AppConfig, NormalizedProfileConfig, RepoConfigFile } from "./types";

let cachedConfig: AppConfig | null = null;

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function parsePort(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resolveEnvPath(): string | null {
  const explicit = asNonEmptyString(process.env[ENV_KEYS.recaplyEnvPath]);
  if (explicit) return explicit;

  const candidate = path.resolve(process.cwd(), ".env");
  return fs.existsSync(candidate) ? candidate : null;
}

function resolveConfigPath(): string {
  const explicit = asNonEmptyString(process.env[ENV_KEYS.recaplyConfigPath]);
  if (explicit) return explicit;
  return path.resolve(process.cwd(), "config.json");
}

function readJsonFile(filePath: string): unknown | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logger.error("Failed to read config.json", error instanceof Error ? error : undefined);
    logger.debug("configPath", filePath);
    return null;
  }
}

function normalizeProfile(raw: unknown): NormalizedProfileConfig {
  const fallback: NormalizedProfileConfig = {
    git: {
      rootPaths: [],
      defaultRepos: [],
      authorPattern: "",
      includeStat: true,
      sinceFallback: "30 days ago",
    },
    output: {
      directory: null,
    },
    schedule: {
      enabled: false,
      cron: "0 18 * * *",
      timezone: DEFAULTS.scheduleTimezone,
    },
  };

  if (!isRecord(raw)) return fallback;

  const git = isRecord(raw.git) ? raw.git : {};
  const output = isRecord(raw.output) ? raw.output : {};
  const schedule = isRecord(raw.schedule) ? raw.schedule : {};

  const rootPaths = Array.isArray(git.rootPaths)
    ? git.rootPaths.filter(
        (v): v is string => typeof v === "string" && v.trim().length > 0
      )
    : [];

  const defaultRepos = Array.isArray(git.defaultRepos)
    ? git.defaultRepos.filter(
        (v): v is string => typeof v === "string" && v.trim().length > 0
      )
    : [];

  const authorPattern = asNonEmptyString(git.authorPattern) ?? "";

  const includeStatFromFile =
    typeof git.includeStat === "boolean" ? git.includeStat : fallback.git.includeStat;

  const sinceFallback = asNonEmptyString(git.sinceFallback) ?? fallback.git.sinceFallback;

  const outputDirectory = asNonEmptyString(output.directory);

  const scheduleEnabled =
    typeof schedule.enabled === "boolean" ? schedule.enabled : fallback.schedule.enabled;

  const scheduleCron = asNonEmptyString(schedule.cron) ?? fallback.schedule.cron;

  const scheduleTimezone =
    asNonEmptyString(schedule.timezone) ?? fallback.schedule.timezone;

  return {
    git: {
      rootPaths,
      defaultRepos,
      authorPattern,
      includeStat: includeStatFromFile,
      sinceFallback,
    },
    output: {
      directory: outputDirectory,
    },
    schedule: {
      enabled: scheduleEnabled,
      cron: scheduleCron,
      timezone: scheduleTimezone,
    },
  };
}

function getActiveProfile(configFile: unknown): NormalizedProfileConfig {
  if (!isRecord(configFile)) return normalizeProfile(null);

  const repoConfig = configFile as RepoConfigFile;
  const profiles = isRecord(repoConfig.profiles) ? (repoConfig.profiles as Record<string, unknown>) : null;
  const activeProfile = asNonEmptyString(repoConfig.activeProfile) ?? "default";

  const rawProfile = profiles?.[activeProfile] ?? profiles?.default ?? null;
  return normalizeProfile(rawProfile);
}

function resolveOutputDir(configPath: string, profile: NormalizedProfileConfig): string {
  const envOutputDir = asNonEmptyString(process.env[ENV_KEYS.recaplyOutputDir]);
  if (envOutputDir) return path.resolve(envOutputDir);

  const fromFile = profile.output.directory;
  if (fromFile) {
    const base = path.dirname(configPath);
    return path.resolve(base, fromFile);
  }

  return path.resolve(process.cwd(), DEFAULTS.outputDirectory);
}

function loadDotEnvOnce(envPath: string | null) {
  if (!envPath) return;

  try {
    dotenv.config({ path: envPath });
  } catch (error) {
    logger.error("Failed to load .env", error instanceof Error ? error : undefined);
    logger.debug("envPath", envPath);
  }
}

export function getConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  const envPath = resolveEnvPath();
  loadDotEnvOnce(envPath);

  const configPath = resolveConfigPath();
  const configFile = readJsonFile(configPath);
  const profile = getActiveProfile(configFile);

  const port =
    parsePort(process.env[ENV_KEYS.port]) ??
    parsePort((isRecord(configFile) && (configFile as any).port) || null) ??
    DEFAULTS.serverPort;

  const includeStat =
    process.env[ENV_KEYS.gitIncludeStat] !== "0" && profile.git.includeStat !== false;

  const outputDir = resolveOutputDir(configPath, profile);

  const defaultRootPath =
    asNonEmptyString(process.env[ENV_KEYS.projectsRoot]) ||
    profile.git.rootPaths[0] ||
    null;

  cachedConfig = {
    server: { port },
    repos: { defaultRootPath },
    git: {
      includeStat,
      rootPaths: profile.git.rootPaths,
    },
    paths: {
      envPath,
      configPath,
      outputDir,
    },
    schedule: profile.schedule,
  };

  return cachedConfig;
}

export function resetConfigCacheForTestsOnly() {
  cachedConfig = null;
}
