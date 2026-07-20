import { open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { AssetAvailabilityResolver } from '../storage/index';
import type { SyncAssetReader } from '../sync/index';

/**
 * Containment is deliberately lexical: `realpath` would add a check/read TOCTOU gap. Only the
 * trusted capture process writes the root, so untrusted relative keys cannot introduce symlinks.
 */

const UNREADABLE_SAFE_MESSAGE = 'Local asset is unreadable.';

type LocalAssetUnreadableError = Error & {
  code: 'local_asset_unreadable';
  retryable: false;
  safeMessage: string;
};

function localAssetUnreadable(): LocalAssetUnreadableError {
  return Object.assign(new Error('Local asset is unreadable.'), {
    code: 'local_asset_unreadable' as const,
    retryable: false as const,
    safeMessage: UNREADABLE_SAFE_MESSAGE,
  });
}

export function isResolvedPathWithinRoot(root: string, resolvedPath: string): boolean {
  return resolvedPath.startsWith(root + path.sep);
}

export function resolveCaptureAssetPath(assetRoot: string, localAccessKey: string): string {
  const root = path.resolve(assetRoot);

  if (
    localAccessKey.length === 0 ||
    localAccessKey.startsWith('file://') ||
    path.isAbsolute(localAccessKey) ||
    /^[A-Za-z]:[\\/]/.test(localAccessKey) ||
    localAccessKey.split(/[\\/]+/).includes('..')
  ) {
    throw localAssetUnreadable();
  }

  const resolvedPath = path.resolve(root, localAccessKey);

  if (!isResolvedPathWithinRoot(root, resolvedPath)) {
    throw localAssetUnreadable();
  }

  return resolvedPath;
}

export type LocalAssetReaderOptions = {
  assetRoot: string;
};

export type LocalAssetRemover = (localAccessKey: string) => Promise<void>;

export function createLocalAssetReader(options: LocalAssetReaderOptions): SyncAssetReader {
  const root = path.resolve(options.assetRoot);

  return async (localAccessKey: string): Promise<Uint8Array> => {
    const resolvedPath = resolveCaptureAssetPath(root, localAccessKey);

    try {
      return await readFile(resolvedPath);
    } catch {
      throw localAssetUnreadable();
    }
  };
}

export function createLocalAssetAvailabilityResolver(
  options: LocalAssetReaderOptions,
): AssetAvailabilityResolver {
  const root = path.resolve(options.assetRoot);

  return {
    async checkAvailability(asset) {
      let resolvedPath: string;
      try {
        resolvedPath = resolveCaptureAssetPath(root, asset.localAccessKey);
      } catch {
        return { availabilityState: 'unreadable' };
      }

      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(resolvedPath, 'r');
      } catch (error) {
        return { availabilityState: isNotFoundError(error) ? 'missing' : 'unreadable' };
      }

      try {
        return (await handle.stat()).isFile()
          ? { availabilityState: 'available' }
          : { availabilityState: 'unreadable' };
      } catch {
        return { availabilityState: 'unreadable' };
      } finally {
        await handle.close().catch(() => undefined);
      }
    },
  };
}

export function createLocalAssetRemover(options: LocalAssetReaderOptions): LocalAssetRemover {
  const root = path.resolve(options.assetRoot);

  return async (localAccessKey: string): Promise<void> => {
    const resolvedPath = resolveCaptureAssetPath(root, localAccessKey);

    try {
      await unlink(resolvedPath);
    } catch (error) {
      if (isNotFoundError(error)) {
        return;
      }
      throw localAssetCleanupFailed();
    }
  };
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function localAssetCleanupFailed(): Error {
  return Object.assign(new Error('Local asset cleanup failed.'), {
    code: 'local_asset_cleanup_failed',
    retryable: true,
    safeMessage: 'Local asset cleanup failed.',
  });
}
