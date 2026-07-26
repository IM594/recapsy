import { describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { extractFile, listPackage } from '@electron/asar';
import productIdentity from '../../src/product-identity.json';

const packagedAppPath =
  process.env.RECAPSY_DESKTOP_PACKAGED_APP ??
  path.resolve(
    'dist',
    'release',
    `${productIdentity.displayName}-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`,
    `${productIdentity.displayName}.app`,
  );
const contentsPath = path.join(packagedAppPath, 'Contents');
const resourcesPath = path.join(contentsPath, 'Resources');
const applicationArchivePath = path.join(resourcesPath, 'app.asar');
const captureBundlePath = path.join(
  contentsPath,
  'Frameworks',
  productIdentity.captureBundleDirectoryName,
);

describe('packaged Electron application layout', () => {
  it('produces the preview application with the frozen outer bundle id', () => {
    expect(existsSync(packagedAppPath)).toBe(true);
    expect(readBundleValue(packagedAppPath, 'CFBundleIdentifier')).toBe(productIdentity.bundleId);
    expect(readBundleValue(packagedAppPath, 'CFBundleDisplayName')).toBe(
      productIdentity.displayName,
    );
    expect(readBundleValue(packagedAppPath, 'CFBundleExecutable')).toBe(
      productIdentity.displayName,
    );
    expect(() =>
      execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', packagedAppPath]),
    ).not.toThrow();
  });

  it('loads the Electron framework before any application JavaScript runs', () => {
    const executablePath = path.join(contentsPath, 'MacOS', productIdentity.displayName);
    const result = spawnSync(
      executablePath,
      ['-e', 'process.stdout.write(process.versions.electron)'],
      {
        encoding: 'utf8',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('keeps the application archive minimal and resolves all login assets', () => {
    const archiveEntries = listPackage(applicationArchivePath, { isPack: false });
    const allowedArchiveEntries = new Set([
      '/dist',
      '/dist/auth',
      '/dist/auth/login-preload.js',
      '/dist/auth/login-window.html',
      '/dist/main',
      '/dist/main/electron-entry.js',
      '/dist/shell',
      '/dist/shell/main-preload.js',
      '/dist/shell/main-window.html',
      '/package.json',
    ]);

    expect(archiveEntries).toContain('/dist/main/electron-entry.js');
    expect(archiveEntries).toContain('/dist/auth/login-preload.js');
    expect(archiveEntries).toContain('/dist/auth/login-window.html');
    expect(archiveEntries).toContain('/dist/shell/main-preload.js');
    expect(archiveEntries).toContain('/dist/shell/main-window.html');
    expect(archiveEntries.some((entry) => entry.startsWith('/src'))).toBe(false);
    expect(archiveEntries.some((entry) => entry.startsWith('/tests'))).toBe(false);
    expect(archiveEntries.some((entry) => entry.includes('/macos/.build'))).toBe(false);
    expect(archiveEntries.some((entry) => entry.startsWith('/node_modules'))).toBe(false);
    expect(archiveEntries.every((entry) => allowedArchiveEntries.has(entry))).toBe(true);

    const packageJson = JSON.parse(
      extractFile(applicationArchivePath, 'package.json').toString('utf8'),
    ) as { main?: string };
    expect(packageJson.main).toBe('dist/main/electron-entry.js');
  });

  it('embeds valid independently signed capture code in the nested-code directory', async () => {
    const launcherPath = path.join(captureBundlePath, 'Contents', 'MacOS', 'CaptureLauncher');
    const capturePath = path.join(
      captureBundlePath,
      'Contents',
      'MacOS',
      productIdentity.captureExecutableName,
    );

    expect(readBundleValue(captureBundlePath, 'CFBundleIdentifier')).toBe(
      productIdentity.captureBundleId,
    );
    expect(readBundleValue(captureBundlePath, 'CFBundleName')).toBe(
      productIdentity.captureDisplayName,
    );
    expect(readBundleValue(captureBundlePath, 'CFBundleDisplayName')).toBe(
      productIdentity.captureDisplayName,
    );
    expect(readBundleValue(captureBundlePath, 'CFBundleExecutable')).toBe(
      productIdentity.captureExecutableName,
    );
    expect(existsSync(path.join(resourcesPath, productIdentity.captureBundleDirectoryName))).toBe(
      false,
    );
    expect((await stat(launcherPath)).mode & 0o111).not.toBe(0);
    expect((await stat(capturePath)).mode & 0o111).not.toBe(0);
    expect(() =>
      execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', captureBundlePath]),
    ).not.toThrow();
  });

  it('enforces the configured signing-channel policy and matches the host architecture', () => {
    const outerExecutablePath = path.join(contentsPath, 'MacOS', productIdentity.displayName);
    const launcherPath = path.join(captureBundlePath, 'Contents', 'MacOS', 'CaptureLauncher');
    const capturePath = path.join(
      captureBundlePath,
      'Contents',
      'MacOS',
      productIdentity.captureExecutableName,
    );
    const outerSigning = readSigningMetadata(packagedAppPath);
    const nestedSigning = readSigningMetadata(captureBundlePath);

    if (process.env.RECAPSY_CAPTURE_SIGN_IDENTITY === undefined) {
      expect(outerSigning.isAdHoc).toBe(true);
      expect(nestedSigning.isAdHoc).toBe(false);
    } else if (process.env.RECAPSY_CAPTURE_SIGN_IDENTITY === '-') {
      expect(outerSigning.isAdHoc).toBe(true);
      expect(nestedSigning.isAdHoc).toBe(true);
    } else {
      expect(outerSigning.teamIdentifier).toBeTruthy();
      expect(nestedSigning.teamIdentifier).toBe(outerSigning.teamIdentifier);
    }

    const hostArchitecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    for (const executablePath of [outerExecutablePath, launcherPath, capturePath]) {
      expect(readArchitectures(executablePath)).toContain(hostArchitecture);
    }
  });
});

function readBundleValue(bundlePath: string, key: string): string {
  return execFileSync('/usr/bin/plutil', [
    '-extract',
    key,
    'raw',
    '-o',
    '-',
    path.join(bundlePath, 'Contents', 'Info.plist'),
  ])
    .toString('utf8')
    .trim();
}

function readSigningMetadata(bundlePath: string): {
  authorities: string[];
  isAdHoc: boolean;
  teamIdentifier?: string;
} {
  const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', bundlePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error('Unable to read code-signing metadata.');
  }
  const metadata = `${result.stdout}${result.stderr}`;
  const teamIdentifier = metadata.match(/^TeamIdentifier=(.+)$/m)?.[1];
  const authorities = [...metadata.matchAll(/^Authority=(.+)$/gm)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  );
  return {
    authorities,
    isAdHoc: /^Signature=adhoc$/m.test(metadata),
    teamIdentifier: teamIdentifier === 'not set' ? undefined : teamIdentifier,
  };
}

function readArchitectures(executablePath: string): string[] {
  return execFileSync('/usr/bin/lipo', ['-archs', executablePath], { encoding: 'utf8' })
    .trim()
    .split(/\s+/);
}
