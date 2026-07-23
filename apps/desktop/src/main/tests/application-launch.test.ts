import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('desktop development launch', () => {
  it('starts Electron from the Desktop package root after building the declared main entry', async () => {
    const packageSource = await readFile(path.join(desktopRoot, 'package.json'), 'utf8');
    const packageJson = JSON.parse(packageSource) as {
      main?: unknown;
      scripts?: Record<string, unknown>;
    };

    expect(packageJson.main).toBe('dist/main/electron-entry.js');
    expect(packageJson.scripts?.start).toBe('electron .');
    expect(packageJson.scripts?.dev).toBe('pnpm run build && pnpm run start');
  });

  it('does not bind a production outbox job-count hard reject into the SQLite store', async () => {
    const entrySource = await readFile(
      path.join(desktopRoot, 'src', 'main', 'electron-entry.ts'),
      'utf8',
    );

    expect(entrySource).not.toContain('maxActiveOutboxJobs');
    expect(entrySource).toContain('createSqliteStore({');
  });

  it('resolves the device identity after readiness and limits environment overrides to development', async () => {
    const entrySource = await readFile(
      path.join(desktopRoot, 'src', 'main', 'electron-entry.ts'),
      'utf8',
    );

    expect(entrySource).toContain("from './device-identity'");
    expect(entrySource).toContain('process.env.RECAPSY_DESKTOP_DEV_DEVICE_ID');
    expect(entrySource).not.toContain('RECAPSY_DESKTOP_DEVICE_ID');
    expect(entrySource).not.toContain("'dev-device'");
    expect(entrySource).toContain('resolveDeviceId: () =>');
    expect(entrySource).toContain("directory: app.getPath('userData')");
    expect(entrySource).toContain('isDevelopment: !app.isPackaged');
  });
});
