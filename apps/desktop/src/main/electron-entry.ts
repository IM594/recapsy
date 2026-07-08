import path from 'node:path';
import { BrowserWindow, app, ipcMain } from 'electron';
import { createAuthClient } from '../auth/auth-client';
import { createLoginWindowPrompter } from '../auth/login-window';
import { createInMemoryTokenStore } from '../auth/token-store';
import { createSpawnCaptureHelperClient } from '../helper/spawn-capture-helper-client';
import { createServerApiClient } from '../server-api/client';
import type { ServerApiTransport } from '../server-api/types';
import { createSqliteOperationalStore } from '../storage';
import { createNodeSqliteDatabase } from '../storage/node-sqlite-driver';
import { createElectronMainRuntime } from './electron-main-runtime';

/**
 * Thin, genuinely-`electron`-importing entry point. Everything with actual
 * decision logic lives in `electron-main-runtime.ts` (duck-typed against
 * `electron`, unit-testable with `bun test`); this file only supplies real
 * `app`/`ipcMain`/`BrowserWindow` plus dev-only dependency instances. It
 * cannot itself be exercised under `bun test` (real Electron is required),
 * so it is verified by manual smoke test instead — see the task notes for
 * that run.
 *
 * All V0-specific values below (helper command/args, SQLite path, device id,
 * server endpoint) are read from environment variables with dev-only
 * fallbacks; none of the fallbacks encode a secret, a production
 * domain/port, or a specific person's filesystem path.
 *
 * The default helper path is resolved from `process.cwd()` rather than this
 * file's own `import.meta.url`: the `build` script bundles this file into a
 * single flat `dist/main/electron-entry.js`, which would make an
 * `import.meta.url`-relative path point at the wrong place once bundled.
 * `pnpm run dev` / `pnpm run start` (see package.json) always run with this
 * package's directory as `cwd`, so `process.cwd()` reliably means
 * `apps/desktop` here. The same reasoning applies to the login window's
 * preload script and HTML file below.
 */
const defaultHelperEntry = path.join(process.cwd(), 'src', 'helper', 'dev-helper-process.ts');

const helperCommand = process.env.RECAPSY_DESKTOP_HELPER_COMMAND ?? 'bun';
const helperArgs = process.env.RECAPSY_DESKTOP_HELPER_ARGS
  ? process.env.RECAPSY_DESKTOP_HELPER_ARGS.split(' ')
  : [defaultHelperEntry];
const deviceId = process.env.RECAPSY_DESKTOP_DEVICE_ID ?? 'dev-device';
// Dev-only default matches `apps/server`'s own dev default (`PORT=3000` in
// `apps/server/.env.example`), not a production domain or port.
const serverEndpoint = process.env.RECAPSY_SERVER_ENDPOINT ?? 'http://localhost:3000';

/**
 * V0 has no macOS Keychain integration yet (see `auth/token-store.ts`'s
 * `createMacOsKeychainTokenStore` — implemented but not wired in here, per
 * this task's explicit scope). An in-memory token store means every process
 * restart starts signed out again; this is a known, honest limitation, not a
 * silent stand-in for real persistence.
 */
const tokenStore = createInMemoryTokenStore();

/**
 * `fetch`-backed transport shared by the auth client and the server API
 * client, matching the same shape `integration/server-http-smoke.test.ts`
 * already exercises against a real HTTP server.
 */
const fetchTransport: ServerApiTransport = async (request) => {
  const headers = new Headers(request.headers);
  const response = await fetch(request.url, {
    body: encodeTransportBody(request.body, headers),
    headers,
    method: request.method,
  });

  return {
    body: await decodeTransportBody(response),
    headers: Object.fromEntries(response.headers.entries()),
    status: response.status,
  };
};

const authClient = createAuthClient({
  endpoint: serverEndpoint,
  tokenStore,
  transport: fetchTransport,
});

const loginWindowHtmlPath = path.join(process.cwd(), 'src', 'auth', 'login-window.html');
// Unlike the raw-TypeScript dev helper (spawned as a child process running
// under `bun`, which can interpret `.ts` directly), Electron's
// `webPreferences.preload` loads its script through Node's own module
// loader with no TypeScript support. So, unlike `login-window.html` above,
// the preload script does need a compiled JS output — see the `build`
// script in `package.json`, which now also bundles
// `auth/login-window-preload.ts` into `dist/auth/login-window-preload.js`.
// That bundle is specifically built with `--format cjs`: Electron's preload
// loader only supports CommonJS (`require`), not ESM `import` — unlike this
// file's own bundle, which Electron's main process loads through Node's
// regular, ESM-capable module loader (this package's `"type": "module"`
// applies there). An ESM preload bundle loads silently as if it never ran:
// `contextBridge.exposeInMainWorld` never executes and the renderer sees no
// `window.recapsyAuth`, with no thrown error surfaced to this process.
const loginWindowPreloadPath = path.join(process.cwd(), 'dist', 'auth', 'login-window-preload.js');

const loginPrompter = createLoginWindowPrompter({
  authClient,
  createWindow: () =>
    new BrowserWindow({
      height: 360,
      resizable: false,
      title: 'Recapsy sign in (dev)',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: loginWindowPreloadPath,
      },
      width: 420,
    }),
  htmlFilePath: loginWindowHtmlPath,
  ipcMain,
});

// `createElectronMainRuntime` itself registers `window-all-closed` and
// `before-quit` synchronously and gates store/runtime creation on
// `app.whenReady()` internally — see its doc comment. `createStore` is a
// lazy factory so `app.getPath('userData')` is only read once Electron is
// actually ready, without this file needing its own `whenReady().then()`.
const { ready } = createElectronMainRuntime({
  app,
  authClient,
  createHelperClient: () =>
    createSpawnCaptureHelperClient({ args: helperArgs, command: helperCommand }),
  createServerApi: () =>
    createServerApiClient({ endpoint: serverEndpoint, tokenStore, transport: fetchTransport }),
  createStore: () => {
    const sqlitePath =
      process.env.RECAPSY_DESKTOP_SQLITE_PATH ??
      path.join(app.getPath('userData'), 'recapsy-desktop-dev.sqlite3');

    return createSqliteOperationalStore({ database: createNodeSqliteDatabase(sqlitePath) });
  },
  deviceId,
  ipcMain,
  loginPrompter,
  tokenStore,
});

ready.catch((error: unknown) => {
  // Dev-only top-level guard so a startup failure is visible instead of a
  // silently-dead process; this is not the structured/redacted logging the
  // full runtime will eventually have.
  console.error('[recapsy-desktop] desktop runtime failed to start', error);
  app.exit(1);
});

function encodeTransportBody(body: unknown, headers: Headers): BodyInit | undefined {
  if (body === undefined) {
    return undefined;
  }

  if (body instanceof Uint8Array) {
    const buffer = new ArrayBuffer(body.byteLength);
    new Uint8Array(buffer).set(body);
    return buffer;
  }

  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  return JSON.stringify(body);
}

async function decodeTransportBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined;
  }

  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    return await response.json();
  }

  const text = await response.text();
  return text ? { text } : undefined;
}
