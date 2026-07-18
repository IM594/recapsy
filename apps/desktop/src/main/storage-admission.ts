import { constants } from 'node:fs';
import { access, mkdir, open, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { CaptureStorageAdmissionOptions } from '../capture/index';

type StorageProbeFileSystem = {
  access(path: string, mode: number): Promise<void>;
  statfs(path: string): Promise<{ bavail: bigint | number; bsize: bigint | number }>;
};

type StorageWriteProbeHandle = {
  close(): Promise<void>;
  sync(): Promise<void>;
  writeFile(bytes: Uint8Array): Promise<void>;
};

type StorageWriteProbeFileSystem = {
  mkdir(path: string): Promise<void>;
  open(path: string): Promise<StorageWriteProbeHandle>;
  unlink(path: string): Promise<void>;
};

export type LocalStorageAdmissionProbeOptions = {
  assetRoot: string;
  fileSystem?: StorageProbeFileSystem;
};

export type LocalStorageWriteVerifierOptions = {
  assetRoot: string;
  fileSystem?: StorageWriteProbeFileSystem;
};

const STORAGE_WRITE_PROBE_NAME = '.recapsy-admission-write-probe';

const nodeFileSystem: StorageProbeFileSystem = {
  access,
  statfs: async (target) => statfs(target),
};

const nodeWriteProbeFileSystem: StorageWriteProbeFileSystem = {
  mkdir: async (target) => {
    await mkdir(target, { recursive: true });
  },
  open: async (target) => open(target, 'wx', 0o600),
  unlink,
};

/**
 * Samples the physical filesystem that owns the capture root. This uses
 * statfs plus a permission check only: admission never creates probe files
 * and never deletes accepted jobs or assets to manufacture recovery.
 */
export function createLocalStorageAdmissionProbe(
  options: LocalStorageAdmissionProbeOptions,
): CaptureStorageAdmissionOptions['probe'] {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const assetRoot = path.resolve(options.assetRoot);

  return async () => {
    const { probePath, stats } = await statNearestExistingPath(fileSystem, assetRoot);
    let writable = true;
    try {
      await fileSystem.access(probePath, constants.W_OK | constants.X_OK);
    } catch {
      writable = false;
    }

    return {
      availableBytes: availableBytes(stats),
      writable,
    };
  };
}

/**
 * Proves that the capture root can durably accept a write after an observed
 * asset failure. The fixed probe name is safe under the process-wide
 * single-instance boundary and bounds crash residue to one self-owned file;
 * accepted capture assets and outbox rows are never touched.
 */
export function createLocalStorageWriteVerifier(
  options: LocalStorageWriteVerifierOptions,
): CaptureStorageAdmissionOptions['verifyWrite'] {
  const fileSystem = options.fileSystem ?? nodeWriteProbeFileSystem;
  const assetRoot = path.resolve(options.assetRoot);

  return async () => {
    const probePath = path.join(assetRoot, STORAGE_WRITE_PROBE_NAME);
    let handle: StorageWriteProbeHandle | undefined;
    let created = false;
    let failed = false;

    try {
      await fileSystem.mkdir(assetRoot);
      try {
        await fileSystem.unlink(probePath);
      } catch (error) {
        if (!isMissingPath(error)) {
          throw error;
        }
      }
      handle = await fileSystem.open(probePath);
      created = true;
      await handle.writeFile(new Uint8Array([0]));
      await handle.sync();
    } catch {
      failed = true;
    } finally {
      try {
        await handle?.close();
      } catch {
        failed = true;
      }
      if (created) {
        try {
          await fileSystem.unlink(probePath);
        } catch {
          failed = true;
        }
      }
    }

    if (failed) {
      throw new Error('storage_write_verification_failed');
    }
  };
}

async function statNearestExistingPath(
  fileSystem: StorageProbeFileSystem,
  assetRoot: string,
): Promise<{
  probePath: string;
  stats: { bavail: bigint | number; bsize: bigint | number };
}> {
  let probePath = assetRoot;
  while (true) {
    try {
      return { probePath, stats: await fileSystem.statfs(probePath) };
    } catch (error) {
      const parent = path.dirname(probePath);
      if (!isMissingPath(error) || parent === probePath) {
        throw error;
      }
      probePath = parent;
    }
  }
}

function availableBytes(stats: { bavail: bigint | number; bsize: bigint | number }): number {
  const bytes = BigInt(stats.bavail) * BigInt(stats.bsize);
  if (bytes <= 0n) {
    return 0;
  }
  return Number(bytes > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : bytes);
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
