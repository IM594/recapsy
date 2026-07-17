import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageArchitecture = process.arch === 'arm64' ? 'arm64' : 'x64';
const captureBundlePath = path.join(
  desktopRoot,
  'dist',
  'release',
  `Recapsy-darwin-${packageArchitecture}`,
  'Recapsy.app',
  'Contents',
  'Frameworks',
  'RecapsyCapture.app',
);

if (!existsSync(captureBundlePath)) {
  throw new Error('The packaged capture bundle is unavailable.');
}

const testProcess = Bun.spawn({
  cmd: [process.execPath, 'test', 'tests/integration/capture-bundle-process.test.ts'],
  cwd: desktopRoot,
  env: { ...process.env, RECAPSY_CAPTURE_BUNDLE: captureBundlePath },
  stderr: 'inherit',
  stdout: 'inherit',
});

process.exitCode = await testProcess.exited;
