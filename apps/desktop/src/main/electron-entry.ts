import path from 'node:path';
import { app, ipcMain } from 'electron';
import { createSpawnCaptureHelperClient } from '../helper/spawn-capture-helper-client';
import { createSqliteOperationalStore } from '../storage';
import { createNodeSqliteDatabase } from '../storage/node-sqlite-driver';
import { createElectronMainRuntime } from './electron-main-runtime';

/**
 * Thin, genuinely-`electron`-importing entry point. Everything with actual
 * decision logic lives in `electron-main-runtime.ts` (duck-typed against
 * `electron`, unit-testable with `bun test`); this file only supplies real
 * `app`/`ipcMain` plus dev-only dependency instances. It cannot itself be
 * exercised under `bun test` (real Electron is required), so it is verified
 * by manual smoke test instead — see the task notes for that run.
 *
 * All V0-specific values below (helper command/args, SQLite path, device id,
 * workspace id) are read from environment variables with dev-only
 * fallbacks; none of the fallbacks encode a secret, a production
 * domain/port, or a specific person's filesystem path.
 *
 * The default helper path is resolved from `process.cwd()` rather than this
 * file's own `import.meta.url`: the `build` script bundles this file into a
 * single flat `dist/electron-entry.js`, which would make an
 * `import.meta.url`-relative path point at the wrong place once bundled.
 * `pnpm run dev` / `pnpm run start` (see package.json) always run with this
 * package's directory as `cwd`, so `process.cwd()` reliably means
 * `apps/desktop` here.
 */
const defaultHelperEntry = path.join(process.cwd(), 'src', 'helper', 'dev-helper-process.ts');

const helperCommand = process.env.RECAPSY_DESKTOP_HELPER_COMMAND ?? 'bun';
const helperArgs = process.env.RECAPSY_DESKTOP_HELPER_ARGS
  ? process.env.RECAPSY_DESKTOP_HELPER_ARGS.split(' ')
  : [defaultHelperEntry];
const deviceId = process.env.RECAPSY_DESKTOP_DEVICE_ID ?? 'dev-device';
const workspaceId = process.env.RECAPSY_DESKTOP_WORKSPACE_ID ?? 'dev-workspace';

// `createElectronMainRuntime` itself registers `window-all-closed` and
// `before-quit` synchronously and gates store/runtime creation on
// `app.whenReady()` internally — see its doc comment. `createStore` is a
// lazy factory so `app.getPath('userData')` is only read once Electron is
// actually ready, without this file needing its own `whenReady().then()`.
const { ready } = createElectronMainRuntime({
  app,
  createHelperClient: () =>
    createSpawnCaptureHelperClient({ args: helperArgs, command: helperCommand }),
  createStore: () => {
    const sqlitePath =
      process.env.RECAPSY_DESKTOP_SQLITE_PATH ??
      path.join(app.getPath('userData'), 'recapsy-desktop-dev.sqlite3');

    return createSqliteOperationalStore({ database: createNodeSqliteDatabase(sqlitePath) });
  },
  deviceId,
  ipcMain,
  workspaceId,
});

ready.catch((error: unknown) => {
  // Dev-only top-level guard so a startup failure is visible instead of a
  // silently-dead process; this is not the structured/redacted logging the
  // full runtime will eventually have.
  console.error('[recapsy-desktop] desktop runtime failed to start', error);
  app.exit(1);
});
