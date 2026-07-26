import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import productIdentity from '../../product-identity.json';

describe('desktop product identity', () => {
  it('keeps preview display names separate from stable technical identifiers', () => {
    expect(productIdentity).toEqual({
      bundleId: 'one.recapsy.desktop',
      captureBundleDirectoryName: 'Recapsy Preview Capture.app',
      captureBundleId: 'one.recapsy.desktop.capture',
      captureDisplayName: 'Recapsy Preview Capture',
      captureExecutableName: 'Recapsy Preview Capture',
      displayName: 'Recapsy Preview',
      legacyOperationalDatabaseFilename: 'recapsy-desktop-dev.sqlite3',
      legacyProfileDirectoryName: 'Recapsy',
      operationalDatabaseFilename: 'operational.sqlite3',
      profileDirectoryName: 'one.recapsy.desktop',
    });
  });

  it('uses the preview names on static user-visible surfaces', () => {
    const sourceRoot = path.resolve(import.meta.dir, '..', '..');
    const loginWindow = readFileSync(path.join(sourceRoot, 'auth', 'login-window.html'), 'utf8');
    const mainWindow = readFileSync(path.join(sourceRoot, 'shell', 'main-window.html'), 'utf8');

    expect(loginWindow).toContain(productIdentity.displayName);
    expect(mainWindow).toContain(productIdentity.displayName);
    expect(mainWindow).toContain(productIdentity.captureDisplayName);
  });
});
