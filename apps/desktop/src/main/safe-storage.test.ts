import { describe, expect, it } from 'bun:test';
import {
  type SafeStorageLike,
  type SecretStoreFs,
  createSafeStorageSecretStore,
} from './safe-storage';

/** In-memory fake filesystem so tests never touch the real disk. */
function makeFakeFs(): SecretStoreFs {
  const files = new Map<string, Buffer>();
  const directories = new Set<string>();

  return {
    async mkdir(directoryPath) {
      directories.add(directoryPath);
      return undefined;
    },
    async readFile(filePath) {
      const data = files.get(filePath);
      if (!data) {
        const error = new Error(
          `ENOENT: no such file, open '${filePath}'`,
        ) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return data;
    },
    async rm(filePath) {
      files.delete(filePath);
    },
    async writeFile(filePath, data) {
      files.set(filePath, data);
    },
  };
}

/** In-memory fake `safeStorage`: "encryption" is just a reversible prefix tag. */
function makeFakeSafeStorage(options?: {
  corruptOn?: (encrypted: Buffer) => boolean;
}): SafeStorageLike {
  return {
    decryptString(encrypted) {
      if (options?.corruptOn?.(encrypted)) {
        throw new Error('decryption failed');
      }
      const text = encrypted.toString('utf8');
      if (!text.startsWith('enc:')) {
        throw new Error('decryption failed');
      }
      return text.slice('enc:'.length);
    },
    encryptString(plainText) {
      return Buffer.from(`enc:${plainText}`, 'utf8');
    },
    isEncryptionAvailable() {
      return true;
    },
  };
}

const DIRECTORY = '/fake/userData/secure';

describe('createSafeStorageSecretStore', () => {
  it('round-trips the exact string written', async () => {
    const store = createSafeStorageSecretStore({
      directory: DIRECTORY,
      fs: makeFakeFs(),
      safeStorage: makeFakeSafeStorage(),
    });

    await store.write('one.recapsy.desktop.auth', 'default', '{"accessToken":"abc123"}');
    const result = await store.read('one.recapsy.desktop.auth', 'default');

    expect(result).toBe('{"accessToken":"abc123"}');
  });

  it('returns null when reading before any write', async () => {
    const store = createSafeStorageSecretStore({
      directory: DIRECTORY,
      fs: makeFakeFs(),
      safeStorage: makeFakeSafeStorage(),
    });

    const result = await store.read('one.recapsy.desktop.auth', 'default');

    expect(result).toBeNull();
  });

  it('delete removes the secret so a subsequent read returns null', async () => {
    const store = createSafeStorageSecretStore({
      directory: DIRECTORY,
      fs: makeFakeFs(),
      safeStorage: makeFakeSafeStorage(),
    });

    await store.write('one.recapsy.desktop.auth', 'default', 'secret-value');
    await store.delete('one.recapsy.desktop.auth', 'default');
    const result = await store.read('one.recapsy.desktop.auth', 'default');

    expect(result).toBeNull();
  });

  it('delete on a never-written pair is a no-op success (ENOENT treated as already gone)', async () => {
    const store = createSafeStorageSecretStore({
      directory: DIRECTORY,
      fs: makeFakeFs(),
      safeStorage: makeFakeSafeStorage(),
    });

    await expect(store.delete('one.recapsy.desktop.auth', 'default')).resolves.toBeUndefined();
  });

  it('tolerates a corrupted/undecryptable file by returning null instead of throwing', async () => {
    const fakeFs = makeFakeFs();
    const store = createSafeStorageSecretStore({
      directory: DIRECTORY,
      fs: fakeFs,
      safeStorage: makeFakeSafeStorage({ corruptOn: () => true }),
    });

    await store.write('one.recapsy.desktop.auth', 'default', 'secret-value');
    const result = await store.read('one.recapsy.desktop.auth', 'default');

    expect(result).toBeNull();
  });

  it('propagates a non-ENOENT fs error instead of swallowing it', async () => {
    const fakeFs = makeFakeFs();
    const failingFs: SecretStoreFs = {
      ...fakeFs,
      async readFile(filePath) {
        const error = new Error(
          `EACCES: permission denied, open '${filePath}'`,
        ) as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      },
    };
    const store = createSafeStorageSecretStore({
      directory: DIRECTORY,
      fs: failingFs,
      safeStorage: makeFakeSafeStorage(),
    });

    await expect(store.read('one.recapsy.desktop.auth', 'default')).rejects.toMatchObject({
      code: 'EACCES',
    });
  });

  it('does not let two different (service, account) pairs collide', async () => {
    const store = createSafeStorageSecretStore({
      directory: DIRECTORY,
      fs: makeFakeFs(),
      safeStorage: makeFakeSafeStorage(),
    });

    await store.write('one.recapsy.desktop.auth', 'default', 'secret-for-default');
    await store.write('one.recapsy.desktop.auth', 'work', 'secret-for-work');

    const defaultResult = await store.read('one.recapsy.desktop.auth', 'default');
    const workResult = await store.read('one.recapsy.desktop.auth', 'work');

    expect(defaultResult).toBe('secret-for-default');
    expect(workResult).toBe('secret-for-work');
  });
});
