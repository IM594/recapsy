import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CaptureBundleValidationAdapter } from './bundle-client';

const execFileAsync = promisify(execFile);

/** macOS adapter for the capture bundle trust checks performed before spawn. */
export function createNodeCaptureBundleValidationAdapter(): CaptureBundleValidationAdapter {
  return {
    async readBundleIdentifier(bundlePath): Promise<string> {
      const infoPlistPath = path.join(bundlePath, 'Contents', 'Info.plist');
      const { stdout } = await execFileAsync('/usr/bin/plutil', [
        '-extract',
        'CFBundleIdentifier',
        'raw',
        '-o',
        '-',
        infoPlistPath,
      ]);
      return stdout.trim();
    },
    async isExecutable(executablePath): Promise<boolean> {
      try {
        await access(executablePath, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    async verifyCodeSignature(bundlePath): Promise<boolean> {
      try {
        await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundlePath]);
        return true;
      } catch {
        return false;
      }
    },
  };
}
