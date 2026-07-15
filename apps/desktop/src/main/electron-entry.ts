import path from 'node:path';
import { BrowserWindow, app, ipcMain, safeStorage } from 'electron';
import {
  createAuthClient,
  createInMemoryTokenStore,
  createLoginWindowPrompter,
} from '../auth/index';
import {
  createCaptureBundleClient,
  createNodeCaptureBundleValidationAdapter,
} from '../capture/index';
import { createServerApiClient } from '../server/index';
import { createSqliteStore } from '../storage/index';
import { createNodeSqliteDatabase } from '../storage/node';
import type { SyncAssetReader } from '../sync/index';
import { resolveDesktopApplicationPaths } from './application-layout';
import { createLocalAssetReader } from './asset-reader';
import { createAuthStorage } from './auth-storage';
import { createDevVisibility } from './dev-visibility';
import { createHttpTransport } from './http-transport';
import { createElectronMainRuntime } from './runtime';
import { createSafeStorageSecretStore } from './safe-storage';

/**
 * Thin, genuinely-`electron`-importing entry point. Lifecycle decisions live
 * in `runtime.ts`, while HTTP, diagnostics, and auth storage are isolated in
 * narrow testable adapters; this file only supplies real
 * `app`/`ipcMain`/`BrowserWindow` plus concrete dependency instances. It
 * cannot itself be exercised under `bun test` (real Electron is required),
 * so it is verified by manual smoke test instead — see the task notes for
 * that run.
 *
 * All configurable values below (capture override, SQLite path, device id,
 * server endpoint) are read from environment variables with dev-only
 * fallbacks; none of the fallbacks encode a secret, a production
 * domain/port, or a specific person's filesystem path.
 *
 * Runtime paths come from Electron's application and resources roots, never
 * from the caller's working directory. Development and packaged execution
 * therefore share the same real-bundle model.
 */
const helperCommandOverride = process.env.RECAPSY_DESKTOP_HELPER_COMMAND;
const helperArgumentOverride = process.env.RECAPSY_DESKTOP_HELPER_ARGS;
const deviceId = process.env.RECAPSY_DESKTOP_DEVICE_ID ?? 'dev-device';
// Dev-only default matches `apps/server`'s own dev default (`PORT=3000` in
// `apps/server/.env.example`), not a production domain or port.
const serverEndpoint = process.env.RECAPSY_SERVER_ENDPOINT ?? 'http://localhost:3000';

/**
 * Opt-in diagnostic mode for local development (the #1 complaint blocking
 * easy manual testing: after login this app has no window and no Dock icon,
 * so a developer has zero visibility that anything is happening). When set,
 * this keeps the Dock icon visible and prints concise, one-line capture/sync
 * progress logs through `dev-visibility.ts`. Off by default — this must never
 * change V0's default dockless, silent behavior; see the `undefined` fallbacks
 * passed to `createElectronMainRuntime` below when this is false.
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
 * Reverse-DNS-style secret namespace for the encrypted token file (see
 * `safe-storage.ts`'s filename hash, which folds this in).
 * `'default'` is the account: V0 is single-profile (no multi-account
 * switching yet), so this literally names "this device's one local session"
 * — a real business concept, not a placeholder.
 */
const AUTH_SECRET_SERVICE = 'one.recapsy.desktop.auth';
const AUTH_SECRET_ACCOUNT = 'default';

/**
 * Directory the encrypted auth-token file lives under, derived from
 * Electron's per-user data directory. Resolved lazily and memoized for the
 * same reason as `resolveCaptureAssetRoot` above: `app.getPath('userData')`
 * is only valid after `app.whenReady()`, and the auth storage facade only
 * invokes this resolver from inside that post-ready window.
 */
let secureDirectory: string | undefined;
function resolveSecureDirectory(): string {
  secureDirectory ??= path.join(app.getPath('userData'), 'secure');
  return secureDirectory;
}

/**
 * Real persistence for login across restarts, backed by Electron's built-in
 * `safeStorage` (see `safe-storage.ts` for the full rationale). It uses an
 * OS-protected per-app encryption key. Raw token data stays in the
 * encrypted local file and is never written directly to the OS key store or
 * passed through a CLI argument.
 *
 * The facade resolves lazily (like `resolveCaptureAssetRoot`/
 * `resolveCaptureAssetReader` above), so `safeStorage.isEncryptionAvailable()`
 * and `app.getPath` are never touched before `app.whenReady()`.
 */
const tokenStore = createAuthStorage({
  account: AUTH_SECRET_ACCOUNT,
  createSecretStore: () =>
    createSafeStorageSecretStore({
      directory: resolveSecureDirectory(),
      safeStorage,
    }),
  fallback: createInMemoryTokenStore,
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  service: AUTH_SECRET_SERVICE,
});

/**
 * `fetch`-backed transport shared by the auth client and the server API
 * client, matching the same shape `tests/integration/server-http.test.ts`
 * already exercises against a real HTTP server.
 */
const fetchTransport = createHttpTransport();
const devVisibility = createDevVisibility();
const captureBundleValidationAdapter = createNodeCaptureBundleValidationAdapter();

const authClient = createAuthClient({
  endpoint: serverEndpoint,
  tokenStore,
  transport: fetchTransport,
});

const { loginWindowHtmlPath, loginWindowPreloadPath } = resolveDesktopApplicationPaths(
  app.getAppPath(),
);

const loginPrompter = createLoginWindowPrompter({
  authClient,
  createWindow: () =>
    new BrowserWindow({
      height: 360,
      resizable: false,
      title: 'Recapsy sign in',
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
    createCaptureBundleClient({
      captureEnvironment: { [CAPTURE_ASSET_ROOT_ENV]: resolveCaptureAssetRoot() },
      isPackaged: app.isPackaged,
      override: helperCommandOverride
        ? {
            args: helperArgumentOverride ? [helperArgumentOverride] : undefined,
            command: helperCommandOverride,
          }
        : undefined,
      packageRoot: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      validationAdapter: captureBundleValidationAdapter,
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

    return createSqliteStore({ database: createNodeSqliteDatabase(sqlitePath) });
  },
  deviceId,
  hideDockIcon: devVisibilityEnabled ? false : undefined,
  ipcMain,
  loginPrompter,
  onHelperEnvelope: devVisibilityEnabled ? devVisibility.onHelperEnvelope : undefined,
  onSyncError: devVisibilityEnabled ? devVisibility.onSyncError : undefined,
  onSyncResult: devVisibilityEnabled ? devVisibility.onSyncResult : undefined,
  // Real asset-byte reader for the sync loop, replacing the runtime's
  // fail-closed default. Bound to the same `resolveCaptureAssetRoot()` the
  // capture process is handed above, so writer and reader share one root.
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
