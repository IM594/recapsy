import { existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import productIdentity from '../product-identity.json';

export type OperationalDatabaseFileSystem = {
  exists(path: string): boolean;
  rename(from: string, to: string): void;
};

export type PrepareOperationalDatabaseOptions = {
  directory: string;
  fileSystem?: OperationalDatabaseFileSystem;
  overridePath?: string;
};

const nodeFileSystem: OperationalDatabaseFileSystem = {
  exists: existsSync,
  rename: renameSync,
};

const SQLITE_SIDECAR_SUFFIXES = ['', '-wal', '-shm'] as const;

export function resolveOperationalDatabasePath(directory: string): string {
  return path.join(directory, productIdentity.operationalDatabaseFilename);
}

export function migrateLegacyOperationalDatabase(
  directory: string,
  fileSystem: OperationalDatabaseFileSystem = nodeFileSystem,
): 'migrated' | 'not_needed' | 'target_exists' {
  const targetPath = resolveOperationalDatabasePath(directory);
  const legacyPath = path.join(directory, productIdentity.legacyOperationalDatabaseFilename);
  const targetExists = fileSystem.exists(targetPath);
  const legacyExists = fileSystem.exists(legacyPath);

  if (targetExists && legacyExists) {
    throw new Error('Both operational and legacy databases exist; refusing to merge');
  }
  if (targetExists) {
    return 'target_exists';
  }
  if (!legacyExists) {
    return 'not_needed';
  }

  const moves = SQLITE_SIDECAR_SUFFIXES.filter((suffix) =>
    fileSystem.exists(`${legacyPath}${suffix}`),
  ).map((suffix) => ({ from: `${legacyPath}${suffix}`, to: `${targetPath}${suffix}` }));

  for (const move of moves) {
    if (fileSystem.exists(move.to)) {
      throw new Error(`Operational database migration target already exists: ${move.to}`);
    }
  }

  const completed: typeof moves = [];
  try {
    for (const move of moves) {
      fileSystem.rename(move.from, move.to);
      completed.push(move);
    }
  } catch (error) {
    for (const move of completed.reverse()) {
      fileSystem.rename(move.to, move.from);
    }
    throw error;
  }

  return 'migrated';
}

export function prepareOperationalDatabase(options: PrepareOperationalDatabaseOptions): string {
  if (options.overridePath !== undefined) {
    return options.overridePath;
  }

  migrateLegacyOperationalDatabase(options.directory, options.fileSystem);
  return resolveOperationalDatabasePath(options.directory);
}
