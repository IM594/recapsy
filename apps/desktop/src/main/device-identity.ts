import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type DeviceIdentityFs = {
  mkdir(
    directoryPath: string,
    options: { mode: number; recursive: true },
  ): Promise<string | undefined>;
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  writeFile(
    filePath: string,
    contents: string,
    options: { encoding: 'utf8'; flag: 'wx'; mode: number },
  ): Promise<void>;
};

const realFs: DeviceIdentityFs = {
  mkdir: (directoryPath, options) => mkdir(directoryPath, options),
  readFile: (filePath, encoding) => readFile(filePath, encoding),
  writeFile: (filePath, contents, options) => writeFile(filePath, contents, options),
};

const DEVICE_IDENTITY_FILE_NAME = 'device-identity';
const OPAQUE_DEVICE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVELOPMENT_OVERRIDE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type ResolveDesktopDeviceIdOptions = {
  directory: string;
  isDevelopment: boolean;
  developmentOverride?: string;
  createOpaqueId?(): string;
  fs?: DeviceIdentityFs;
};

/**
 * Resolves the device-local, non-user-derived identity used by capture and
 * policy requests. Development may opt into a deterministic identity, but a
 * packaged app always reads or creates its own stable local identity.
 */
export async function resolveDesktopDeviceId(
  options: ResolveDesktopDeviceIdOptions,
): Promise<string> {
  if (options.isDevelopment && options.developmentOverride !== undefined) {
    if (!DEVELOPMENT_OVERRIDE_PATTERN.test(options.developmentOverride)) {
      throw new Error('Invalid development desktop device identity override');
    }
    return options.developmentOverride;
  }

  const fs = options.fs ?? realFs;
  const filePath = path.join(options.directory, DEVICE_IDENTITY_FILE_NAME);
  const persisted = await readPersistedDeviceId(fs, filePath);
  if (persisted !== null) {
    return persisted;
  }

  await fs.mkdir(options.directory, { mode: 0o700, recursive: true });
  const deviceId = (options.createOpaqueId ?? randomUUID)();
  if (!OPAQUE_DEVICE_ID_PATTERN.test(deviceId)) {
    throw new Error('Generated desktop device identity is not opaque');
  }

  try {
    await fs.writeFile(filePath, `${deviceId}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return deviceId;
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'EEXIST') {
      throw error;
    }
    return readRequiredPersistedDeviceId(fs, filePath);
  }
}

async function readPersistedDeviceId(
  fs: DeviceIdentityFs,
  filePath: string,
): Promise<string | null> {
  try {
    return parsePersistedDeviceId(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function readRequiredPersistedDeviceId(
  fs: DeviceIdentityFs,
  filePath: string,
): Promise<string> {
  return parsePersistedDeviceId(await fs.readFile(filePath, 'utf8'));
}

function parsePersistedDeviceId(contents: string): string {
  const deviceId = contents.endsWith('\n') ? contents.slice(0, -1) : contents;
  if (!OPAQUE_DEVICE_ID_PATTERN.test(deviceId)) {
    throw new Error('Invalid persisted desktop device identity');
  }
  return deviceId;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
