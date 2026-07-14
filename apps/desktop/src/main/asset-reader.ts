import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SyncAssetReader } from '../sync/public';

/**
 * Real cross-process asset-byte reader for the sync loop, replacing the
 * `failClosedReadAssetBytes` placeholder in `runtime.ts`. The
 * capture process writes each screenshot into a shared local asset root
 * (derived from Electron `app.getPath('userData')`) and `capture.result`
 * carries only a *relative* access key such as `<captureId>/screenshot.jpg`
 * (the protocol layer already rejects absolute paths and `file://` before
 * they can cross the process boundary — see ADR 0009 "真实资产字节的跨进程读取").
 *
 * This reader joins that relative key onto the known root and reads the bytes,
 * with directory-traversal protection so a malformed or hostile key can never
 * make the sync loop read a file outside the asset root. Any illegal key or
 * read failure (including a not-yet-written / missing file, which is exactly
 * what the V0 dev helper produces) fails closed with the
 * `local_asset_unreadable` safe-error shape `sync/scheduler.ts` already maps to
 * a terminal `blocked` outbox state. The thrown error never contains an
 * absolute path.
 *
 * Symlink boundary (known, deliberate): containment is validated *lexically*
 * only — `path.resolve` normalizes the key, but this reader does NOT resolve
 * symlinks (no `realpath`). A symlink that lives *inside* the asset root but
 * points outside it would be followed by `readFile`. This is accepted rather
 * than closed off with `realpath` on purpose: `realpath` adds an extra IO
 * round trip and a TOCTOU gap between the check and the read. The guarantee
 * relied on instead is that only the trusted capture process ever *writes*
 * into the asset root — a relative access key alone cannot create a symlink —
 * so no such escaping link exists to follow. Recorded here as an auditable
 * fact of the threat model, not an oversight.
 */

const UNREADABLE_SAFE_MESSAGE = 'Local asset is unreadable.';

type LocalAssetUnreadableError = Error & {
  code: 'local_asset_unreadable';
  retryable: false;
  safeMessage: string;
};

/**
 * Fail-closed error matching the shape `sync/scheduler.ts`'s `isSafeErrorShape`
 * / `isLocalAssetSafeCode` detect (`code` + `safeMessage` + `retryable`). The
 * `message` is deliberately generic and path-free: neither it nor `safeMessage`
 * may leak the absolute path being read, per the same privacy contract as
 * `failClosedReadAssetBytes` and `safeLocalAccessKey`.
 */
function localAssetUnreadable(): LocalAssetUnreadableError {
  return Object.assign(new Error('Local asset is unreadable.'), {
    code: 'local_asset_unreadable' as const,
    retryable: false as const,
    safeMessage: UNREADABLE_SAFE_MESSAGE,
  });
}

/**
 * True only when `resolvedPath` sits *strictly inside* `root` — i.e. under it,
 * never `root` itself (the asset root is a directory; a valid key always names
 * a file beneath it). The trailing `path.sep` does double duty: it both
 * excludes `root` itself and defeats the prefix trap, so a sibling directory
 * that merely shares a name prefix (root `/x/root` vs `/x/root-evil`) is not
 * treated as contained. This is the single place the "reject the root itself"
 * decision lives. Exported so this exact boundary is unit-testable in isolation.
 */
export function isResolvedPathWithinRoot(root: string, resolvedPath: string): boolean {
  return resolvedPath.startsWith(root + path.sep);
}

/**
 * Resolves a relative asset access key against `assetRoot` and validates it
 * cannot escape the root. Throws the `local_asset_unreadable` shape on any
 * illegal key. Exported (pure, no IO) so the traversal guard is directly
 * testable.
 */
export function resolveCaptureAssetPath(assetRoot: string, localAccessKey: string): string {
  const root = path.resolve(assetRoot);

  // Reject up front the forms `path.resolve` would either honor as an escape
  // or silently treat as harmless-but-wrong:
  // - empty key: nothing to read.
  // - absolute POSIX / Windows-drive paths: an absolute key must never cross
  //   the process boundary (the protocol already enforces this; this is
  //   defense in depth).
  // - `file://` URLs: `path.resolve` treats these as *relative* on POSIX, so
  //   they would pass the containment check below and read a bogus in-root
  //   path — reject them explicitly instead.
  // - any `..` segment: rejected outright rather than relying only on the
  //   containment check, so the intent ("no traversal") is enforced at the
  //   key level too.
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

  // Backstop containment check: even if the guards above miss a case, anything
  // that does not resolve to a path strictly inside the root — including the
  // root directory itself — is refused before any IO. `isResolvedPathWithinRoot`
  // owns the root-self rejection.
  if (!isResolvedPathWithinRoot(root, resolvedPath)) {
    throw localAssetUnreadable();
  }

  return resolvedPath;
}

export type LocalAssetReaderOptions = {
  /** Absolute local asset root (e.g. `<userData>/captures`); see module doc. */
  assetRoot: string;
};

/**
 * Builds the real `SyncAssetReader` bound to a fixed local asset root. Every
 * illegal key or read failure fails closed with `local_asset_unreadable`.
 */
export function createLocalAssetReader(options: LocalAssetReaderOptions): SyncAssetReader {
  const root = path.resolve(options.assetRoot);

  return async (localAccessKey: string): Promise<Uint8Array> => {
    const resolvedPath = resolveCaptureAssetPath(root, localAccessKey);

    try {
      return await readFile(resolvedPath);
    } catch {
      // Any IO failure (missing file, permission, EISDIR, ...) collapses to
      // the same fail-closed shape. The underlying error is intentionally
      // dropped so no absolute path can leak into logs or the sync layer.
      throw localAssetUnreadable();
    }
  };
}
