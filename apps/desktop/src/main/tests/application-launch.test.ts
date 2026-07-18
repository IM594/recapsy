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

  it('passes the capture queue hard limit into the production SQLite store', async () => {
    const entrySource = await readFile(
      path.join(desktopRoot, 'src', 'main', 'electron-entry.ts'),
      'utf8',
    );

    expect(entrySource).toContain('maxActiveOutboxJobs: DEFAULT_CAPTURE_MAX_QUEUED_JOBS');
  });
});
