import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { makeUniversalApp } from '@electron/universal';

const execFileAsync = promisify(execFile);
const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptsDirectory, '..');
const releaseRoot = path.join(desktopRoot, 'dist', 'release');
const releaseInputsRoot = path.join(releaseRoot, 'release-input');
const distributionRoot = path.join(releaseRoot, 'distribution');
const command = process.argv[2] ?? 'plan';

class ReleaseConfigurationError extends Error {}

try {
  await runCommand(command);
} catch (error) {
  console.error(
    error instanceof ReleaseConfigurationError ? error.message : 'Release operation failed.',
  );
  process.exitCode = 1;
}

async function runCommand(value: string) {
  switch (value) {
    case 'plan':
      console.log(
        JSON.stringify({
          commands: {
            assemble: 'release:assemble',
            notarize: 'release:notarize',
            rollback: 'release:verify-rollback',
            stage: 'release:stage',
            verify: 'release:verify',
          },
          requiredExternalInputs: [
            'RECAPSY_RELEASE_SIGN_IDENTITY',
            'APPLE_NOTARY_KEY',
            'APPLE_NOTARY_KEY_ID',
            'APPLE_NOTARY_ISSUER_ID',
            'RECAPSY_RELEASE_PREVIOUS_VERSION',
          ],
        }),
      );
      return;
    case 'stage':
      await stageArchitecture();
      return;
    case 'assemble':
      await assembleUniversalApplication();
      return;
    case 'notarize':
      await notarizeDistribution();
      return;
    case 'verify':
      await verifyDistribution();
      return;
    case 'verify-rollback':
      await verifyRollbackArtifact();
      return;
    default:
      throw new ReleaseConfigurationError('Unknown release command.');
  }
}

async function stageArchitecture() {
  const architecture = requireArchitecture('RECAPSY_RELEASE_ARCH');
  const identity = requireDeveloperIdIdentity();
  if (architecture !== process.arch) {
    throw new ReleaseConfigurationError(
      'Release staging must run on its requested native architecture.',
    );
  }

  await execFileAsync('pnpm', ['run', 'package:macos'], {
    cwd: desktopRoot,
    env: {
      ...process.env,
      RECAPSY_CAPTURE_ARCH: architecture,
      RECAPSY_CAPTURE_SIGN_IDENTITY: identity,
    },
  });
  const sourceApplication = path.join(releaseRoot, `Recapsy-darwin-${architecture}`, 'Recapsy.app');
  await assertDirectory(sourceApplication, 'Packaged application');
  const stagedApplication = path.join(releaseInputsRoot, `Recapsy-${architecture}.app`);
  await rm(stagedApplication, { force: true, recursive: true });
  await mkdir(releaseInputsRoot, { recursive: true });
  await cp(sourceApplication, stagedApplication, { preserveTimestamps: true, recursive: true });
  await verifySignedApplication(stagedApplication, identity, architecture);
  console.log(stagedApplication);
}

async function assembleUniversalApplication() {
  const x64Application = await requireReleaseInput('RECAPSY_RELEASE_X64_APP', 'x64');
  const arm64Application = await requireReleaseInput('RECAPSY_RELEASE_ARM64_APP', 'arm64');
  const identity = requireDeveloperIdIdentity();
  const version = await requireReleaseVersion();
  const previousVersion = requireVersion('RECAPSY_RELEASE_PREVIOUS_VERSION');
  const universalApplication = path.join(distributionRoot, 'Recapsy.app');
  const archive = path.join(distributionRoot, `Recapsy-${version}-universal.zip`);

  await rm(universalApplication, { force: true, recursive: true });
  await rm(archive, { force: true });
  await mkdir(distributionRoot, { recursive: true });
  await makeUniversalApp({
    arm64AppPath: arm64Application,
    force: true,
    infoPlistsToIgnore: 'Contents/Frameworks/RecapsyCapture.app/Contents/Info.plist',
    mergeASARs: true,
    outAppPath: universalApplication,
    x64AppPath: x64Application,
  });
  await signApplication(universalApplication, identity);
  await verifySignedApplication(universalApplication, identity, 'universal');
  await execFileAsync('/usr/bin/ditto', [
    '-c',
    '-k',
    '--keepParent',
    universalApplication,
    archive,
  ]);
  await writeCandidateManifest({ archive, previousVersion, universalApplication, version });
  console.log(universalApplication);
}

async function notarizeDistribution() {
  const version = await requireReleaseVersion();
  const previousVersion = requireVersion('RECAPSY_RELEASE_PREVIOUS_VERSION');
  const archive = path.join(distributionRoot, `Recapsy-${version}-universal.zip`);
  const universalApplication = path.join(distributionRoot, 'Recapsy.app');
  const diskImage = path.join(distributionRoot, `Recapsy-${version}-universal.dmg`);
  const key = await requireAbsoluteFile('APPLE_NOTARY_KEY');
  const keyId = requireEnvironment('APPLE_NOTARY_KEY_ID');
  const issuer = requireEnvironment('APPLE_NOTARY_ISSUER_ID');

  await assertDirectory(universalApplication, 'Universal application');
  await assertFile(archive, 'Universal archive');
  await execFileAsync('/usr/bin/xcrun', [
    'notarytool',
    'submit',
    archive,
    '--key',
    key,
    '--key-id',
    keyId,
    '--issuer',
    issuer,
    '--wait',
  ]);
  await execFileAsync('/usr/bin/xcrun', ['stapler', 'staple', universalApplication]);
  await execFileAsync('/usr/bin/xcrun', ['stapler', 'validate', universalApplication]);
  await rm(diskImage, { force: true });
  await execFileAsync('/usr/bin/hdiutil', [
    'create',
    '-format',
    'UDZO',
    '-ov',
    '-srcfolder',
    universalApplication,
    '-volname',
    `Recapsy ${version}`,
    diskImage,
  ]);
  await verifySignedApplication(universalApplication, requireDeveloperIdIdentity(), 'universal');
  await execFileAsync('/usr/sbin/spctl', [
    '--assess',
    '--type',
    'open',
    '--context',
    'context:primary-signature',
    universalApplication,
  ]);
  await writeReleaseManifest({
    archive,
    diskImage,
    previousVersion,
    universalApplication,
    version,
  });
  console.log(diskImage);
}

async function verifyDistribution() {
  const version = await requireReleaseVersion();
  const universalApplication = path.join(distributionRoot, 'Recapsy.app');
  const diskImage = path.join(distributionRoot, `Recapsy-${version}-universal.dmg`);
  const manifest = path.join(distributionRoot, `Recapsy-${version}-release.json`);
  await verifySignedApplication(universalApplication, requireDeveloperIdIdentity(), 'universal');
  await assertFile(diskImage, 'Notarized disk image');
  await assertFile(manifest, 'Release manifest');
  await execFileAsync('/usr/bin/hdiutil', ['verify', diskImage]);
  await execFileAsync('/usr/sbin/spctl', [
    '--assess',
    '--type',
    'open',
    '--context',
    'context:primary-signature',
    universalApplication,
  ]);
}

async function verifyRollbackArtifact() {
  const diskImage = await requireAbsoluteFile('RECAPSY_RELEASE_ROLLBACK_DMG');
  const mountPath = path.join(releaseRoot, 'rollback-mount');
  let attached = false;
  await rm(mountPath, { force: true, recursive: true });
  await mkdir(mountPath, { recursive: true });
  try {
    await execFileAsync('/usr/bin/hdiutil', ['verify', diskImage]);
    await execFileAsync('/usr/bin/hdiutil', [
      'attach',
      '-nobrowse',
      '-readonly',
      '-mountpoint',
      mountPath,
      diskImage,
    ]);
    attached = true;
    const application = await findApplicationBundle(mountPath);
    await verifySignedApplication(application, requireDeveloperIdIdentity(), 'universal');
  } finally {
    if (attached) {
      await execFileAsync('/usr/bin/hdiutil', ['detach', mountPath]);
    }
    await rm(mountPath, { force: true, recursive: true });
  }
}

async function requireReleaseInput(name: string, architecture: 'arm64' | 'x64') {
  const raw = requireEnvironment(name);
  if (!path.isAbsolute(raw)) {
    throw new ReleaseConfigurationError(`${name} must be an absolute path.`);
  }
  const resolved = path.resolve(raw);
  assertInsideReleaseInputs(resolved, name);
  await assertDirectory(resolved, name);
  await verifySignedApplication(resolved, requireDeveloperIdIdentity(), architecture);
  return resolved;
}

async function verifySignedApplication(
  application: string,
  identity: string,
  architecture: 'arm64' | 'x64' | 'universal',
) {
  await assertDirectory(application, 'Application bundle');
  await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
  await assertApplicationArchitectures(application, architecture);
  const details = await execFileAsync('/usr/bin/codesign', ['-dv', '--verbose=4', application], {
    encoding: 'utf8',
  });
  if (!details.stderr.includes(identity)) {
    throw new ReleaseConfigurationError(
      'Application signing identity does not match the release identity.',
    );
  }
}

async function signApplication(application: string, identity: string) {
  await execFileAsync('/usr/bin/codesign', [
    '--force',
    '--deep',
    '--options',
    'runtime',
    '--sign',
    identity,
    application,
  ]);
}

async function assertApplicationArchitectures(
  application: string,
  expected: 'arm64' | 'x64' | 'universal',
) {
  const executables = [
    path.join(application, 'Contents', 'MacOS', 'Recapsy'),
    path.join(
      application,
      'Contents',
      'Frameworks',
      'RecapsyCapture.app',
      'Contents',
      'MacOS',
      'Recapsy',
    ),
    path.join(
      application,
      'Contents',
      'Frameworks',
      'RecapsyCapture.app',
      'Contents',
      'MacOS',
      'CaptureLauncher',
    ),
  ];
  for (const executable of executables) {
    const result = await execFileAsync('/usr/bin/lipo', ['-archs', executable], {
      encoding: 'utf8',
    });
    const architectures = result.stdout.trim().split(/\s+/);
    const matches =
      expected === 'universal'
        ? architectures.includes('arm64') && architectures.includes('x86_64')
        : architectures.includes(expected === 'x64' ? 'x86_64' : expected);
    if (!matches) {
      throw new ReleaseConfigurationError(
        'Application executable architecture does not match release stage.',
      );
    }
  }
}

async function writeCandidateManifest(input: {
  archive: string;
  universalApplication: string;
  version: string;
  previousVersion: string;
}) {
  await writeFile(
    path.join(distributionRoot, 'release-candidate.json'),
    `${JSON.stringify(
      {
        archive: path.basename(input.archive),
        previousVersion: input.previousVersion,
        universalApplication: path.basename(input.universalApplication),
        version: input.version,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

async function writeReleaseManifest(input: {
  archive: string;
  diskImage: string;
  universalApplication: string;
  version: string;
  previousVersion: string;
}) {
  await writeFile(
    path.join(distributionRoot, `Recapsy-${input.version}-release.json`),
    `${JSON.stringify(
      {
        artifacts: {
          diskImage: {
            name: path.basename(input.diskImage),
            sha256: await sha256(input.diskImage),
          },
          universalArchive: {
            name: path.basename(input.archive),
            sha256: await sha256(input.archive),
          },
        },
        notarized: true,
        rollback: {
          previousVersion: input.previousVersion,
          verificationCommand: 'pnpm run release:verify-rollback',
        },
        schemaVersion: 1,
        universalApplication: path.basename(input.universalApplication),
        version: input.version,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

async function sha256(filePath: string) {
  return `sha256:${createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex')}`;
}

async function findApplicationBundle(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true });
  const application = entries.find((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
  if (!application) {
    throw new ReleaseConfigurationError(
      'Rollback disk image does not contain an application bundle.',
    );
  }
  return path.join(directory, application.name);
}

async function requireReleaseVersion() {
  const packageManifest = JSON.parse(
    await readFile(path.join(desktopRoot, 'package.json'), 'utf8'),
  ) as { version: string };
  const version = process.env.RECAPSY_RELEASE_VERSION ?? packageManifest.version;
  return requireVersionValue(version, 'RECAPSY_RELEASE_VERSION');
}

function requireArchitecture(name: string): 'arm64' | 'x64' {
  const value = requireEnvironment(name);
  if (value !== 'arm64' && value !== 'x64') {
    throw new ReleaseConfigurationError(`${name} must be arm64 or x64.`);
  }
  return value;
}

function requireDeveloperIdIdentity() {
  const value = requireEnvironment('RECAPSY_RELEASE_SIGN_IDENTITY');
  if (!value.startsWith('Developer ID Application:')) {
    throw new ReleaseConfigurationError(
      'RECAPSY_RELEASE_SIGN_IDENTITY must be a Developer ID Application identity.',
    );
  }
  return value;
}

function requireVersion(name: string) {
  return requireVersionValue(requireEnvironment(name), name);
}

function requireVersionValue(value: string, name: string) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    throw new ReleaseConfigurationError(`${name} must be a semantic version.`);
  }
  return value;
}

function requireEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ReleaseConfigurationError(`${name} is required.`);
  }
  return value;
}

async function requireAbsoluteFile(name: string) {
  const value = requireEnvironment(name);
  if (!path.isAbsolute(value)) {
    throw new ReleaseConfigurationError(`${name} must be an absolute path.`);
  }
  await assertFile(value, name);
  return path.resolve(value);
}

function assertInsideReleaseInputs(candidate: string, name: string) {
  const relative = path.relative(releaseInputsRoot, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ReleaseConfigurationError(`${name} must be inside the release input directory.`);
  }
}

async function assertDirectory(directory: string, label: string) {
  try {
    const entries = await readdir(directory);
    if (entries.length === 0) {
      throw new Error('empty');
    }
  } catch {
    throw new ReleaseConfigurationError(`${label} is missing or unreadable.`);
  }
}

async function assertFile(filePath: string, label: string) {
  try {
    await access(filePath);
  } catch {
    throw new ReleaseConfigurationError(`${label} is missing or unreadable.`);
  }
}
