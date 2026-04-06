import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { StorageConfig } from "../config/schema";
import type { Logger } from "../utils/logger";
import { StorageError } from "../utils/errors";

export interface FileStorage {
  write(relativePath: string, data: Buffer): Promise<void>;
  read(relativePath: string): Promise<Buffer>;
  delete(relativePath: string): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  getAbsolutePath(relativePath: string): string;
}

export interface FileStorageDeps {
  config: StorageConfig;
  logger: Logger;
}

export function createLocalFileStorage(deps: FileStorageDeps): FileStorage {
  const { config, logger: parentLogger } = deps;
  const logger = parentLogger.child({ module: "file-storage" });
  const baseDir = resolve(config.baseDir);

  function absPath(relativePath: string): string {
    const full = resolve(baseDir, relativePath);
    if (!full.startsWith(baseDir + "/") && full !== baseDir) {
      throw new StorageError(`path traversal rejected: ${relativePath}`);
    }
    return full;
  }

  return {
    async write(relativePath, data) {
      const fullPath = absPath(relativePath);
      try {
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, data);
        logger.debug({ path: relativePath, size: data.length }, "file written");
      } catch (error) {
        throw new StorageError(`failed to write file: ${relativePath}`, error);
      }
    },

    async read(relativePath) {
      const fullPath = absPath(relativePath);
      try {
        return await readFile(fullPath);
      } catch (error) {
        throw new StorageError(`failed to read file: ${relativePath}`, error);
      }
    },

    async delete(relativePath) {
      const fullPath = absPath(relativePath);
      try {
        await rm(fullPath, { force: true });
        logger.debug({ path: relativePath }, "file deleted");
      } catch (error) {
        throw new StorageError(`failed to delete file: ${relativePath}`, error);
      }
    },

    async exists(relativePath) {
      const fullPath = absPath(relativePath);
      try {
        await stat(fullPath);
        return true;
      } catch {
        return false;
      }
    },

    getAbsolutePath(relativePath) {
      return absPath(relativePath);
    },
  };
}
