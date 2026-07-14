import path from 'node:path';
import { BrowserWindow, app, ipcMain, safeStorage } from 'electron';
import {
  type TokenStore,
  createAuthClient,
  createInMemoryTokenStore,
  createLoginWindowPrompter,
  createMacOsKeychainTokenStore,
} from '../auth/public';
import {
  type HelperEnvelope,
  type HelperToMainType,
  createSpawnCaptureHelperClient,
} from '../helper/public';
import { type ServerApiTransport, createServerApiClient } from '../server-api/public';
import { createNodeSqliteDatabase } from '../storage/composition';
import { createSqliteOperationalStore } from '../storage/public';
import type { SyncAssetReader, SyncRunResult } from '../sync/public';
import { createLocalAssetReader } from './asset-reader';
import { createElectronMainRuntime } from './electron-main-runtime';
import { createElectronKeychainSecretStore } from './keychain-secret-store';

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
 * Opt-in diagnostic mode for local development (the #1 complaint blocking
 * easy manual testing: after login this app has no window and no Dock icon,
 * so a developer has zero visibility that anything is happening). When set,
 * this keeps the Dock icon visible and prints concise, one-line capture/sync
 * progress logs to stdout via `logHelperEnvelope`/`logSyncResult`/
 * `logSyncError` below. Off by default — this must never change V0's default
 * dockless, silent behavior; see the `undefined` fallbacks passed to
 * `createElectronMainRuntime` below when this is false.
 */
const devVisibilityEnabled = process.env.RECAPSY_DESKTOP_DEV_VISIBILITY === '1';

/**
 * Cross-process contract for the local asset root (ADR 0009 "真实资产字节的跨进程读取"):
 * the capture process writes screenshots under this directory and the sync
 * loop reads them back by relative access key. The name is passed to the
 * capture process through the environment — never spliced into an argv string
 * — because the derived path lives under `app.getPath('userData')`, which on
 * macOS contains spaces (`Application Support`) that space-joined args would
 * corrupt. The V0 real capture binary produced in a later increment reads this
 * same variable.
 */
const CAPTURE_ASSET_ROOT_ENV = 'RECAPSY_CAPTURE_ASSET_ROOT';

/**
 * Single source of truth for the local asset root, derived from Electron's
 * per-user data directory. Resolved lazily and memoized: `app.getPath(...)` is
 * only valid after `app.whenReady()`, and every caller here runs inside a
 * runtime callback that fires post-ready (`createHelperClient` /
 * `readAssetBytes`), mirroring how `createStore` below already defers its own
 * `app.getPath('userData')` read. The `captures` subdirectory is the shared
 * root both the capture process (writer) and the sync loop (reader) agree on.
 */
let captureAssetRoot: string | undefined;
function resolveCaptureAssetRoot(): string {
  captureAssetRoot ??= path.join(app.getPath('userData'), 'captures');
  return captureAssetRoot;
}

/**
 * The sync loop's real asset reader, built once lazily and reused (rather than
 * reconstructed on every read). Same post-ready-only rule as
 * `resolveCaptureAssetRoot`: only ever invoked from the runtime's post-ready
 * `readAssetBytes` callback, so `app.getPath('userData')` is never read before
 * `app.whenReady()`.
 */
let captureAssetReader: SyncAssetReader | undefined;
function resolveCaptureAssetReader(): SyncAssetReader {
  captureAssetReader ??= createLocalAssetReader({ assetRoot: resolveCaptureAssetRoot() });
  return captureAssetReader;
}

/**
 * Reverse-DNS-style Keychain "service" identifier for the encrypted token
 * file (see `keychain-secret-store.ts`'s filename hash, which folds this in).
 * `'default'` is the account: V0 is single-profile (no multi-account
 * switching yet), so this literally names "this device's one local session"
 * — a real business concept, not a placeholder.
 */
const AUTH_KEYCHAIN_SERVICE = 'one.recapsy.desktop.auth';
const AUTH_KEYCHAIN_ACCOUNT = 'default';

/**
 * Directory the encrypted auth-token file lives under, derived from
 * Electron's per-user data directory. Resolved lazily and memoized for the
 * same reason as `resolveCaptureAssetRoot` above: `app.getPath('userData')`
 * is only valid after `app.whenReady()`, and `resolveTokenStore()` below is
 * only ever invoked from inside that post-ready window.
 */
let secureDirectory: string | undefined;
function resolveSecureDirectory(): string {
  secureDirectory ??= path.join(app.getPath('userData'), 'secure');
  return secureDirectory;
}

/**
 * Real persistence for login across restarts, backed by Electron's built-in
 * `safeStorage` (see `keychain-secret-store.ts` for the full rationale: it is
 * genuinely Keychain-backed on macOS via its per-app encryption key, without
 * shelling out to the `security` CLI — which would leak the raw secret via
 * `ps`/process listing — or adding the `keytar` native dependency).
 *
 * `safeStorage.isEncryptionAvailable()` can be false in some environments
 * (CI, or a locked/unavailable OS keychain); when it is, this falls back to
 * the previous in-memory store rather than crashing the app, at the cost of
 * losing login across restarts — the same known, honest limitation V0 always
 * had, now only hit in that degraded case instead of unconditionally.
 *
 * Resolved lazily (like `resolveCaptureAssetRoot`/`resolveCaptureAssetReader`
 * above) so `safeStorage.isEncryptionAvailable()` and `app.getPath` are never
 * touched before `app.whenReady()`.
 */
let tokenStoreInstance: TokenStore | undefined;
function resolveTokenStore(): TokenStore {
  if (tokenStoreInstance) {
    return tokenStoreInstance;
  }

  if (safeStorage.isEncryptionAvailable()) {
    tokenStoreInstance = createMacOsKeychainTokenStore({
      account: AUTH_KEYCHAIN_ACCOUNT,
      secrets: createElectronKeychainSecretStore({
        directory: resolveSecureDirectory(),
        safeStorage,
      }),
      service: AUTH_KEYCHAIN_SERVICE,
    });
  } else {
    console.warn(
      '[recapsy-desktop] OS keychain encryption unavailable; falling back to in-memory token store (login will not persist across restarts).',
    );
    tokenStoreInstance = createInMemoryTokenStore();
  }

  return tokenStoreInstance;
}

/**
 * Lazy facade handed to both `createAuthClient` (below) and
 * `createElectronMainRuntime` (further below) so they share the exact same
 * underlying store once it's built. Constructing *this* object touches
 * neither `app.getPath` nor `safeStorage` — it only calls `resolveTokenStore()`
 * when one of its methods actually runs, which happens from inside the auth
 * client / runtime's own post-ready call paths, never at this module's
 * top-level eval time. This mirrors `readAssetBytes: (key) =>
 * resolveCaptureAssetReader()(key)` further below: an eagerly-handed-out
 * function whose lazy resolver only fires on first real call.
 */
const tokenStore: TokenStore = {
  clearTokens: () => resolveTokenStore().clearTokens(),
  getTokens: () => resolveTokenStore().getTokens(),
  setTokens: (tokens) => resolveTokenStore().setTokens(tokens),
};

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
    createSpawnCaptureHelperClient({
      args: helperArgs,
      command: helperCommand,
      // Hand the shared asset root to the capture process via env (see the
      // `CAPTURE_ASSET_ROOT_ENV` doc above for why it is not an argv value).
      env: { [CAPTURE_ASSET_ROOT_ENV]: resolveCaptureAssetRoot() },
    }),
  createServerApi: () =>
    createServerApiClient({
      accessTokenProvider: {
        getAccessToken: async () => (await tokenStore.getTokens())?.accessToken ?? null,
      },
      endpoint: serverEndpoint,
      transport: fetchTransport,
    }),
  createStore: () => {
    const sqlitePath =
      process.env.RECAPSY_DESKTOP_SQLITE_PATH ??
      path.join(app.getPath('userData'), 'recapsy-desktop-dev.sqlite3');

    return createSqliteOperationalStore({ database: createNodeSqliteDatabase(sqlitePath) });
  },
  deviceId,
  hideDockIcon: devVisibilityEnabled ? false : undefined,
  ipcMain,
  loginPrompter,
  onHelperEnvelope: devVisibilityEnabled ? logHelperEnvelope : undefined,
  onSyncError: devVisibilityEnabled ? logSyncError : undefined,
  onSyncResult: devVisibilityEnabled ? logSyncResult : undefined,
  // Real asset-byte reader for the sync loop, replacing the runtime's
  // fail-closed default. Bound to the same `resolveCaptureAssetRoot()` the
  // capture process is handed above, so writer and reader share one root. In
  // the dev-helper fallback (no real capture binary configured) the dev helper
  // writes nothing to this root, so every read fails closed with
  // `local_asset_unreadable` and the job settles to `blocked` — the same,
  // honest end state as before, now reached through the real filesystem path
  // rather than an unconditional stub.
  readAssetBytes: (localAccessKey) => resolveCaptureAssetReader()(localAccessKey),
  tokenStore,
});

ready.catch((error: unknown) => {
  // Dev-only top-level guard so a startup failure is visible instead of a
  // silently-dead process; this is not the structured/redacted logging the
  // full runtime will eventually have.
  console.error('[recapsy-desktop] desktop runtime failed to start', error);
  app.exit(1);
});

/**
 * `HelperEnvelope<TType>`'s `payload` type is a conditional type keyed off
 * its own generic parameter (see `helper/protocol.ts`), so a plain
 * `switch (envelope.type)` does not narrow `envelope.payload` per case — the
 * same limitation `capture-helper-event-intake.ts`'s own
 * `narrowHelperEnvelope` works around. This is a type-level cast only: the
 * caller must already have confirmed `envelope.type === type` (e.g. inside
 * the matching `switch` case below).
 */
function narrowHelperEnvelope<TType extends HelperToMainType>(
  envelope: HelperEnvelope<HelperToMainType>,
  _type: TType,
): HelperEnvelope<TType> {
  return envelope as HelperEnvelope<TType>;
}

/**
 * Dev-visibility log line for one inbound capture-helper envelope, only ever
 * wired up when `RECAPSY_DESKTOP_DEV_VISIBILITY` is set (see
 * `onHelperEnvelope` below). `helper.heartbeat` is intentionally skipped —
 * it fires every few seconds and would just flood the terminal with
 * nothing-happened noise; the goal is "a developer can tell captures are
 * happening at a glance," not a firehose of every heartbeat.
 */
function logHelperEnvelope(envelope: HelperEnvelope<HelperToMainType>): void {
  switch (envelope.type) {
    case 'capture.result': {
      const { captureId, assets } = narrowHelperEnvelope(envelope, 'capture.result').payload;
      const primaryAsset = assets.find((asset) => asset.role === 'screenshot') ?? assets[0];
      const assetInfo = primaryAsset
        ? `${primaryAsset.mimeType} ${primaryAsset.sizeBytes}B`
        : 'no-asset';
      console.log(
        `[recapsy:capture] result captureId=${captureId} assets=${assets.length} ${assetInfo}`,
      );
      return;
    }
    case 'capture.skipped': {
      const payload = narrowHelperEnvelope(envelope, 'capture.skipped').payload;
      console.log(
        `[recapsy:capture] skipped captureId=${payload.captureId} reason=${payload.reason}`,
      );
      return;
    }
    case 'capture.error': {
      const payload = narrowHelperEnvelope(envelope, 'capture.error').payload;
      console.log(
        `[recapsy:capture] error code=${payload.code}${
          payload.captureId ? ` captureId=${payload.captureId}` : ''
        }`,
      );
      return;
    }
    case 'helper.exiting': {
      const payload = narrowHelperEnvelope(envelope, 'helper.exiting').payload;
      console.log(
        `[recapsy:capture] helper exiting reason=${payload.reason} code=${payload.code ?? 'null'}`,
      );
      return;
    }
    case 'permission.status': {
      const payload = narrowHelperEnvelope(envelope, 'permission.status').payload;
      console.log(
        `[recapsy:capture] permissions accessibility=${payload.accessibility} screenRecording=${payload.screenCapture}`,
      );
      return;
    }
    case 'helper.hello': {
      const payload = narrowHelperEnvelope(envelope, 'helper.hello').payload;
      console.log(
        `[recapsy:capture] helper hello version=${payload.helperVersion} pid=${payload.pid ?? 'unknown'}`,
      );
      return;
    }
    case 'helper.status': {
      const payload = narrowHelperEnvelope(envelope, 'helper.status').payload;
      console.log(
        `[recapsy:capture] helper status=${payload.status}${
          payload.reason ? ` reason=${payload.reason}` : ''
        }`,
      );
      return;
    }
    case 'helper.heartbeat':
      return;
  }
}

/**
 * Dev-visibility log line for one sync loop outcome. `idle` is deliberately
 * not logged: the sync loop reschedules itself every `idleDelayMs` (default
 * 2000ms) whenever there is nothing to do, so logging it would flood the
 * terminal with nothing-happened noise. `skipped`/`synced`/`retry_wait`/
 * `blocked`/`failed`/`cancelled` all reflect real job activity.
 */
function logSyncResult(result: SyncRunResult): void {
  if (result.status === 'idle') {
    return;
  }

  const parts = [`status=${result.status}`];

  if (result.jobId) {
    parts.push(`jobId=${result.jobId}`);
  }

  if (result.code) {
    parts.push(`code=${result.code}`);
  }

  console.log(`[recapsy:sync] ${parts.join(' ')}`);
}

function logSyncError(error: unknown): void {
  console.error('[recapsy:sync] error', error);
}

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
