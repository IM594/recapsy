import { existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import productIdentity from '../product-identity.json';

export const DESKTOP_APPLICATION_NAME = productIdentity.displayName;

export type DesktopProfileFileSystem = {
  exists(path: string): boolean;
  rename(from: string, to: string): void;
};

const nodeFileSystem: DesktopProfileFileSystem = {
  exists: existsSync,
  rename: renameSync,
};

export type DesktopApplicationProfileHost = {
  getPath(name: 'appData'): string;
  setName(name: string): void;
  setPath(name: 'userData', value: string): void;
};

/** Builds the stable local profile path shared by development and releases. */
export function resolveDesktopUserDataPath(appDataPath: string): string {
  return path.join(appDataPath, productIdentity.profileDirectoryName);
}

export function migrateLegacyDesktopApplicationProfile(
  appDataPath: string,
  fileSystem: DesktopProfileFileSystem = nodeFileSystem,
): 'migrated' | 'not_needed' | 'target_exists' {
  const targetPath = resolveDesktopUserDataPath(appDataPath);
  const legacyPath = path.join(appDataPath, productIdentity.legacyProfileDirectoryName);
  const targetExists = fileSystem.exists(targetPath);
  const legacyExists = fileSystem.exists(legacyPath);

  if (targetExists && legacyExists) {
    throw new Error('Both stable and legacy desktop profiles exist; refusing to merge');
  }
  if (targetExists) {
    return 'target_exists';
  }
  if (!legacyExists) {
    return 'not_needed';
  }

  fileSystem.rename(legacyPath, targetPath);
  return 'migrated';
}

/** Sets the product-owned local profile before any userData consumer starts. */
export function configureDesktopApplicationProfile(
  app: DesktopApplicationProfileHost,
  fileSystem: DesktopProfileFileSystem = nodeFileSystem,
): void {
  app.setName(DESKTOP_APPLICATION_NAME);
  const appDataPath = app.getPath('appData');
  migrateLegacyDesktopApplicationProfile(appDataPath, fileSystem);
  app.setPath('userData', resolveDesktopUserDataPath(appDataPath));
}
