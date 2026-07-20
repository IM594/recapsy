import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type DeviceIdentityFs, resolveDesktopDeviceId } from '../device-identity';

const DIRECTORY = '/fake/userData';
const EXISTING_DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const GENERATED_DEVICE_ID = '22222222-2222-4222-8222-222222222222';

describe('resolveDesktopDeviceId', () => {
  it('uses the production filesystem adapter to retain one generated identity across restarts', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'recapsy-device-identity-'));

    try {
      const first = await resolveDesktopDeviceId({ directory, isDevelopment: false });
      const second = await resolveDesktopDeviceId({ directory, isDevelopment: false });

      expect(first).toBe(second);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('creates an opaque identity once and reuses it after a restart', async () => {
    const fs = makeFakeFs();

    const first = await resolveDesktopDeviceId({
      createOpaqueId: () => GENERATED_DEVICE_ID,
      directory: DIRECTORY,
      fs,
      isDevelopment: false,
    });
    const second = await resolveDesktopDeviceId({
      createOpaqueId: () => {
        throw new Error('a persisted identity must be reused');
      },
      directory: DIRECTORY,
      fs,
      isDevelopment: false,
    });

    expect(first).toBe(GENERATED_DEVICE_ID);
    expect(second).toBe(GENERATED_DEVICE_ID);
    expect(fs.files.get(path.join(DIRECTORY, 'device-identity'))).toBe(`${GENERATED_DEVICE_ID}\n`);
  });

  it('keeps a persisted production identity instead of accepting an environment override', async () => {
    const fs = makeFakeFs({
      [path.join(DIRECTORY, 'device-identity')]: `${EXISTING_DEVICE_ID}\n`,
    });

    const result = await resolveDesktopDeviceId({
      createOpaqueId: () => {
        throw new Error('an existing identity must not be regenerated');
      },
      developmentOverride: 'dev-device',
      directory: DIRECTORY,
      fs,
      isDevelopment: false,
    });

    expect(result).toBe(EXISTING_DEVICE_ID);
    expect(fs.writeCalls).toEqual([]);
  });

  it('uses an explicit development-only override without touching persistent identity state', async () => {
    const fs = makeFakeFs();

    const result = await resolveDesktopDeviceId({
      createOpaqueId: () => {
        throw new Error('the development override must win before persistence');
      },
      developmentOverride: 'dev-device',
      directory: DIRECTORY,
      fs,
      isDevelopment: true,
    });

    expect(result).toBe('dev-device');
    expect(fs.readCalls).toBe(0);
    expect(fs.writeCalls).toEqual([]);
  });

  it('rejects a malformed development override before it can become an identity', async () => {
    await expect(
      resolveDesktopDeviceId({
        developmentOverride: 'not an opaque identity',
        directory: DIRECTORY,
        isDevelopment: true,
      }),
    ).rejects.toThrow('Invalid development desktop device identity override');
  });

  it('rejects a malformed generated identity before writing it', async () => {
    const fs = makeFakeFs();

    await expect(
      resolveDesktopDeviceId({
        createOpaqueId: () => 'not-an-opaque-id',
        directory: DIRECTORY,
        fs,
        isDevelopment: false,
      }),
    ).rejects.toThrow('Generated desktop device identity is not opaque');

    expect(fs.writeCalls).toEqual([]);
  });

  it('uses an identity created by another process instead of overwriting it', async () => {
    const fs = makeFakeFs();
    const writeFile = fs.writeFile.bind(fs);
    fs.writeFile = async (filePath, contents, options) => {
      fs.files.set(filePath, `${EXISTING_DEVICE_ID}\n`);
      await writeFile(filePath, contents, options);
    };

    const result = await resolveDesktopDeviceId({
      createOpaqueId: () => GENERATED_DEVICE_ID,
      directory: DIRECTORY,
      fs,
      isDevelopment: false,
    });

    expect(result).toBe(EXISTING_DEVICE_ID);
    expect(fs.files.get(path.join(DIRECTORY, 'device-identity'))).toBe(`${EXISTING_DEVICE_ID}\n`);
  });

  it('fails closed when a persisted identity is malformed instead of replacing it', async () => {
    const fs = makeFakeFs({
      [path.join(DIRECTORY, 'device-identity')]: 'not-an-opaque-id\n',
    });

    await expect(
      resolveDesktopDeviceId({
        createOpaqueId: () => GENERATED_DEVICE_ID,
        directory: DIRECTORY,
        fs,
        isDevelopment: false,
      }),
    ).rejects.toThrow('Invalid persisted desktop device identity');

    expect(fs.writeCalls).toEqual([]);
  });

  it('fails closed when the first production identity cannot be persisted', async () => {
    const fs = makeFakeFs(undefined, {
      writeError: Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    });

    await expect(
      resolveDesktopDeviceId({
        createOpaqueId: () => GENERATED_DEVICE_ID,
        directory: DIRECTORY,
        fs,
        isDevelopment: false,
      }),
    ).rejects.toMatchObject({ code: 'EACCES' });
  });
});

type FakeDeviceIdentityFs = DeviceIdentityFs & {
  files: Map<string, string>;
  readCalls: number;
  writeCalls: string[];
};

function makeFakeFs(
  initialFiles: Record<string, string> = {},
  options: {
    writeError?: NodeJS.ErrnoException;
  } = {},
): FakeDeviceIdentityFs {
  const files = new Map(Object.entries(initialFiles));
  const writeCalls: string[] = [];
  let readCalls = 0;

  return {
    files,
    get readCalls() {
      return readCalls;
    },
    async mkdir() {
      return undefined;
    },
    async readFile(filePath) {
      readCalls += 1;
      const contents = files.get(filePath);
      if (contents === undefined) {
        throw errno('ENOENT');
      }
      return contents;
    },
    writeCalls,
    async writeFile(filePath, contents) {
      if (options.writeError) {
        throw options.writeError;
      }
      if (files.has(filePath)) {
        throw errno('EEXIST');
      }
      files.set(filePath, contents);
      writeCalls.push(filePath);
    },
  };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}
