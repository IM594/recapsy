import { execFile } from 'node:child_process';
import { access, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { packager } from '@electron/packager';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptsDirectory, '..');
const stagingRoot = path.join(desktopRoot, 'dist', 'application-package');
const releaseRoot = path.join(desktopRoot, 'dist', 'release');
const captureBundlePath = path.join(desktopRoot, 'macos', 'build', 'Recapsy.app');
const configuredSignIdentity = process.env.RECAPSY_CAPTURE_SIGN_IDENTITY;
const execFileAsync = promisify(execFile);
const packagerSignIdentity = configuredSignIdentity ?? '-';

const electronPackage = JSON.parse(
  await readFile(path.join(desktopRoot, 'node_modules', 'electron', 'package.json'), 'utf8'),
) as { version: string };
const targetArchitecture = process.arch === 'arm64' ? 'arm64' : 'x64';
const electronZipDir = await findElectronZipDirectory(
  `electron-v${electronPackage.version}-darwin-${targetArchitecture}.zip`,
);

let outputPaths: string[] = [];
try {
  await prepareMinimalApplication();
  outputPaths = await packager({
    appBundleId: 'one.recapsy.desktop',
    arch: targetArchitecture,
    asar: true,
    dir: stagingRoot,
    electronVersion: electronPackage.version,
    electronZipDir,
    executableName: 'Recapsy',
    extraResource: [captureBundlePath],
    name: 'Recapsy',
    out: releaseRoot,
    overwrite: true,
    platform: 'darwin',
    prune: false,
    // Electron's renamed helpers must always be signed inside-out. CI (`-`)
    // and explicit distribution identities keep this final signature. The
    // implicit development channel temporarily signs everything ad hoc, then
    // restores the independently signed capture bundle below so its stable TCC
    // identity is not replaced.
    osxSign: {
      continueOnError: false,
      identity: packagerSignIdentity,
      identityValidation: false,
    } as unknown as Exclude<Parameters<typeof packager>[0]['osxSign'], undefined>,
    afterComplete: [
      (buildPath, _electronVersion, platform, _arch, callback) => {
        if (platform !== 'darwin') {
          callback(new Error('The Recapsy application can only be signed for macOS.'));
          return;
        }
        const applicationPath = path.join(buildPath, 'Recapsy.app');
        void finalizeApplicationSignature(applicationPath).then(
          () => callback(),
          (error: unknown) =>
            callback(error instanceof Error ? error : new Error('Desktop code signing failed.')),
        );
      },
    ],
    afterCopyExtraResources: [
      (buildPath, _electronVersion, platform, _arch, callback) => {
        if (platform !== 'darwin') {
          callback(new Error('The Recapsy capture bundle can only be packaged for macOS.'));
          return;
        }

        void moveCaptureBundleIntoNestedCodeDirectory(buildPath).then(
          () => callback(),
          (error: unknown) =>
            callback(error instanceof Error ? error : new Error('Capture bundle move failed.')),
        );
      },
    ],
  });
} finally {
  await rm(stagingRoot, { force: true, recursive: true });
}

for (const outputPath of outputPaths) {
  console.log(`packaged desktop application: ${outputPath}`);
}

async function prepareMinimalApplication(): Promise<void> {
  const desktopPackage = JSON.parse(
    await readFile(path.join(desktopRoot, 'package.json'), 'utf8'),
  ) as { version: string };
  const mainBundlePath = path.join(desktopRoot, 'dist', 'main', 'electron-entry.js');
  const preloadBundlePath = path.join(desktopRoot, 'dist', 'auth', 'login-preload.js');
  const loginWindowPath = path.join(desktopRoot, 'dist', 'auth', 'login-window.html');
  const mainWindowPreloadPath = path.join(desktopRoot, 'dist', 'shell', 'main-preload.js');
  const mainWindowPath = path.join(desktopRoot, 'dist', 'shell', 'main-window.html');

  await Promise.all([
    access(captureBundlePath),
    access(mainBundlePath),
    access(preloadBundlePath),
    access(loginWindowPath),
    access(mainWindowPreloadPath),
    access(mainWindowPath),
  ]);

  await rm(stagingRoot, { force: true, recursive: true });
  await mkdir(path.join(stagingRoot, 'dist', 'main'), { recursive: true });
  await mkdir(path.join(stagingRoot, 'dist', 'auth'), { recursive: true });
  await mkdir(path.join(stagingRoot, 'dist', 'shell'), { recursive: true });
  await Promise.all([
    cp(mainBundlePath, path.join(stagingRoot, 'dist', 'main', 'electron-entry.js')),
    cp(preloadBundlePath, path.join(stagingRoot, 'dist', 'auth', 'login-preload.js')),
    cp(loginWindowPath, path.join(stagingRoot, 'dist', 'auth', 'login-window.html')),
    cp(mainWindowPreloadPath, path.join(stagingRoot, 'dist', 'shell', 'main-preload.js')),
    cp(mainWindowPath, path.join(stagingRoot, 'dist', 'shell', 'main-window.html')),
  ]);
  await writeFile(
    path.join(stagingRoot, 'package.json'),
    `${JSON.stringify(
      {
        main: 'dist/main/electron-entry.js',
        name: 'recapsy-desktop',
        private: true,
        productName: 'Recapsy',
        type: 'module',
        version: desktopPackage.version,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

async function moveCaptureBundleIntoNestedCodeDirectory(buildPath: string): Promise<void> {
  const contentsPath = path.join(buildPath, 'Recapsy.app', 'Contents');
  const copiedBundlePath = path.join(contentsPath, 'Resources', 'Recapsy.app');
  const frameworksPath = path.join(contentsPath, 'Frameworks');
  const nestedBundlePath = path.join(frameworksPath, 'RecapsyCapture.app');

  await mkdir(frameworksPath, { recursive: true });
  await rename(copiedBundlePath, nestedBundlePath);
}

async function finalizeApplicationSignature(applicationPath: string): Promise<void> {
  // Electron's framework tree is code, not ordinary bundle resources. Make
  // every runtime component carry the channel identity before sealing the outer
  // application. A shallow outer signature can pass `codesign --deep` while
  // dyld still rejects a framework with a mismatched team requirement.
  await execFileAsync('/usr/bin/codesign', [
    '--force',
    '--deep',
    '--sign',
    packagerSignIdentity,
    applicationPath,
  ]);

  if (configuredSignIdentity) {
    await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', applicationPath]);
    return;
  }

  await restoreDevelopmentCaptureSignature(applicationPath);
}

async function restoreDevelopmentCaptureSignature(applicationPath: string): Promise<void> {
  const frameworksPath = path.join(applicationPath, 'Contents', 'Frameworks');
  const nestedBundlePath = path.join(frameworksPath, 'RecapsyCapture.app');
  const replacementBundlePath = path.join(frameworksPath, 'RecapsyCapture.replacement.app');
  await rm(replacementBundlePath, { force: true, recursive: true });
  await cp(captureBundlePath, replacementBundlePath, { recursive: true });
  await rm(nestedBundlePath, { force: true, recursive: true });
  await rename(replacementBundlePath, nestedBundlePath);
  await execFileAsync('/usr/bin/codesign', ['--force', '--sign', '-', applicationPath]);
  await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', applicationPath]);
}

async function findElectronZipDirectory(zipFilename: string): Promise<string | undefined> {
  const cacheRoot =
    process.env.ELECTRON_CACHE ?? path.join(homedir(), 'Library', 'Caches', 'electron');
  try {
    const entries = await readdir(cacheRoot, { withFileTypes: true, encoding: 'utf8' });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidateDirectory = path.join(cacheRoot, entry.name);
      try {
        await access(path.join(candidateDirectory, zipFilename));
        return candidateDirectory;
      } catch {
        // Continue through content-addressed cache directories.
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}
