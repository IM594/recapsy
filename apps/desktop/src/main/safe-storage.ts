import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { KeychainSecretStore } from '../auth/public';

/**
 * Duck-typed surface of Electron's `safeStorage` module (see
 * `electron-entry.ts`, the only file allowed to import real `electron`). On
 * macOS, `encryptString`/`decryptString` are backed by a per-app key that
 * Electron stores in the OS Keychain — the raw secret itself never touches
 * the Keychain and never crosses a process boundary as a CLI argument, unlike
 * shelling out to `security add-generic-password -w <secret>` (which would
 * leak it briefly via `ps`/process listing). This is the same pattern Chrome
 * and VS Code use: token data lives in a local encrypted file, and only the
 * one encryption key is Keychain-managed and invisible to the user.
 */
export type SafeStorageLike = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

/**
 * Minimal `node:fs/promises` surface this store actually uses, so tests can
 * inject an in-memory fake instead of touching the real filesystem (mirrors
 * the duck-typing style `asset-reader.ts` uses for `SyncAssetReader`, just
 * scoped to the handful of fs calls needed here rather than all of
 * `readFile`).
 */
export type SecretStoreFs = {
  mkdir(directoryPath: string, options: { recursive: true }): Promise<string | undefined>;
  readFile(filePath: string): Promise<Buffer>;
  writeFile(filePath: string, data: Buffer): Promise<void>;
  rm(filePath: string, options: { force: true }): Promise<void>;
};

const realFs: SecretStoreFs = {
  mkdir: (directoryPath, options) => mkdir(directoryPath, options),
  readFile: (filePath) => readFile(filePath),
  writeFile: (filePath, data) => writeFile(filePath, data),
  rm: (filePath, options) => rm(filePath, options),
};

export type SafeStorageSecretStoreOptions = {
  safeStorage: SafeStorageLike;
  /** Directory the encrypted secret files live under (e.g. `<userData>/secure`). */
  directory: string;
  /** Defaults to the real `node:fs/promises` when not injected (tests inject a fake). */
  fs?: SecretStoreFs;
};

/**
 * Builds a `KeychainSecretStore` (see `auth/tokens.ts`) backed by
 * Electron `safeStorage` plus a plain file on disk. One file per
 * `(service, account)` pair, named from a hash of the pair rather than the
 * raw strings — same class of concern `asset-reader.ts` guards against for
 * access keys: untrusted input must never become a path segment verbatim
 * (directory traversal, invalid filename characters, collisions).
 *
 * `read()` degrades to `null` — rather than throwing — for exactly two
 * conditions: the file does not exist yet (first run / never logged in), and
 * the file exists but fails to decrypt (corrupted file, or the OS keychain's
 * encryption key became unavailable since the file was written). Both are
 * "no usable secret here" from the caller's point of view, and
 * `createMacOsKeychainTokenStore` already treats a `null` read as "not logged
 * in" rather than crashing. Any other error (e.g. a permissions failure
 * reading the directory) is intentionally left to propagate, so it stays
 * visible instead of being silently swallowed alongside the two expected
 * cases above.
 */
export function createSafeStorageSecretStore(
  options: SafeStorageSecretStoreOptions,
): KeychainSecretStore {
  const { safeStorage, directory } = options;
  const fs = options.fs ?? realFs;

  return {
    async delete(service, account) {
      const filePath = secretFilePath(directory, service, account);

      try {
        await fs.rm(filePath, { force: true });
      } catch (error) {
        if (!isErrnoException(error) || error.code !== 'ENOENT') {
          throw error;
        }
      }
    },

    async read(service, account) {
      const filePath = secretFilePath(directory, service, account);
      let encrypted: Buffer;

      try {
        encrypted = await fs.readFile(filePath);
      } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
          return null;
        }
        throw error;
      }

      try {
        return safeStorage.decryptString(encrypted);
      } catch {
        // Corrupted file or a since-rotated/unavailable OS-keychain key:
        // degrade to "not found" so a bad local cache never crashes startup.
        return null;
      }
    },

    async write(service, account, secret) {
      await fs.mkdir(directory, { recursive: true });
      const filePath = secretFilePath(directory, service, account);
      const encrypted = safeStorage.encryptString(secret);
      await fs.writeFile(filePath, encrypted);
    },
  };
}

/**
 * Derives a safe on-disk filename for a `(service, account)` pair: a sha256
 * hex digest of `${service}:${account}`, never the raw strings. This both
 * rules out directory-traversal / invalid-filename-character input and
 * avoids ambiguous collisions (e.g. `service="a", account="b:c"` vs
 * `service="a:b", account="c"`), since the hash covers the joined,
 * delimiter-included string, not each part separately.
 */
function secretFilePath(directory: string, service: string, account: string): string {
  const digest = createHash('sha256').update(`${service}:${account}`).digest('hex');
  return path.join(directory, `${digest}.bin`);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
