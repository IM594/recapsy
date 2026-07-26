import path from 'node:path';
import {
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  app,
  ipcMain,
  nativeImage,
  safeStorage,
  shell,
} from 'electron';
import {
  createDesktopAcceptanceHttpTransport,
  createDesktopAcceptancePublisher,
  projectAcceptanceQueue,
} from '../acceptance/index';
import {
  createAuthClient,
  createInMemoryTokenStore,
  createLoginWindowPrompter,
} from '../auth/index';
import {
  createCaptureBundleClient,
  createNodeCaptureBundleValidationAdapter,
} from '../capture/index';
import { createPrivacySettingsOpener, refreshCapturePermissions } from '../permissions/index';
import { createServerApiClient } from '../server/index';
import {
  type DesktopShellStatus,
  createDesktopShell,
  createTrayIconPngBuffer,
} from '../shell/index';
import { type AssetAvailabilityResolver, createSqliteStore } from '../storage/index';
import { createNodeSqliteDatabase } from '../storage/node';
import { type SyncAssetReader, createSyncQueueSummary } from '../sync/index';
import { startDesktopSingleInstance } from './application-instance';
import { resolveDesktopApplicationPaths } from './application-layout';
import {
  DESKTOP_APPLICATION_NAME,
  configureDesktopApplicationProfile,
} from './application-profile';
import {
  createLocalAssetAvailabilityResolver,
  createLocalAssetReader,
  createLocalAssetRemover,
} from './asset-reader';
import { createAuthStorage } from './auth-storage';
import { createDevVisibility } from './dev-visibility';
import { resolveDesktopDeviceId } from './device-identity';
import { createHttpTransport } from './http-transport';
import { prepareOperationalDatabase } from './operational-database';
import { type ElectronMainRuntimeOptions, createElectronMainRuntime } from './runtime';
import { createSafeStorageSecretStore } from './safe-storage';
import {
  createLocalStorageAdmissionProbe,
  createLocalStorageWriteVerifier,
} from './storage-admission';

/**
 * Thin, genuinely-`electron`-importing entry point. Lifecycle decisions live
 * in `runtime.ts`, while HTTP, diagnostics, and auth storage are isolated in
 * narrow testable adapters; this file only supplies real
 * `app`/`ipcMain`/`BrowserWindow`/`Tray` plus concrete dependency instances. It
 * cannot itself be exercised under `bun test` (real Electron is required),
 * so it is verified by manual smoke test instead — see the task notes for
 * that run.
 *
 * Capture override, SQLite path, and server endpoint can be configured by the
 * environment; no fallback encodes a secret, a production domain/port, or a
 * specific person's filesystem path. The device identity is generated and
 * persisted locally instead, with a development-only explicit override.
 *
 * Runtime paths come from Electron's application and resources roots, never
 * from the caller's working directory. Development and packaged execution
 * therefore share the same real-bundle model.
 */
const helperCommandOverride = process.env.RECAPSY_DESKTOP_HELPER_COMMAND;
const helperArgumentOverride = process.env.RECAPSY_DESKTOP_HELPER_ARGS;
const developmentDeviceIdOverride = process.env.RECAPSY_DESKTOP_DEV_DEVICE_ID;
// Dev-only default matches `apps/server`'s own dev default (`PORT=3000` in
// `apps/server/.env.example`), not a production domain or port.
const serverEndpoint = process.env.RECAPSY_SERVER_ENDPOINT ?? 'http://localhost:3000';

// `electron .` uses the package root in development while packaged Electron
// uses app.asar. Set the product-owned profile before any userData consumer so
// both layouts keep one stable local state directory.
configureDesktopApplicationProfile(app);

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

let captureAssetAvailabilityResolver: AssetAvailabilityResolver | undefined;
function resolveCaptureAssetAvailabilityResolver(): AssetAvailabilityResolver {
  captureAssetAvailabilityResolver ??= createLocalAssetAvailabilityResolver({
    assetRoot: resolveCaptureAssetRoot(),
  });
  return captureAssetAvailabilityResolver;
}

let captureAssetRemover: ReturnType<typeof createLocalAssetRemover> | undefined;
function resolveCaptureAssetRemover(): ReturnType<typeof createLocalAssetRemover> {
  captureAssetRemover ??= createLocalAssetRemover({ assetRoot: resolveCaptureAssetRoot() });
  return captureAssetRemover;
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

const desktopPackageRoot = app.getAppPath();
const { loginWindowHtmlPath, loginWindowPreloadPath, mainWindowHtmlPath, mainWindowPreloadPath } =
  resolveDesktopApplicationPaths(desktopPackageRoot);

const loginPrompter = createLoginWindowPrompter({
  authClient,
  createWindow: () =>
    new BrowserWindow({
      height: 360,
      resizable: false,
      title: `${DESKTOP_APPLICATION_NAME} 登录`,
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

const privacySettings = createPrivacySettingsOpener(async (url) => {
  await shell.openExternal(url);
});

// This object only captures adapters and lazy factories. SQLite, helper, and
// shell construction remain behind `createElectronMainRuntime`, which is not
// invoked until the primary process owns Electron's single-instance lock.
const runtimeOptions: ElectronMainRuntimeOptions = {
  app,
  assetResolver: {
    checkAvailability: async (asset) =>
      await resolveCaptureAssetAvailabilityResolver().checkAvailability(asset),
  },
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
      packageRoot: desktopPackageRoot,
      resourcesPath: process.resourcesPath,
      validationAdapter: captureBundleValidationAdapter,
    }),
  createServerApi: () =>
    createServerApiClient({
      accessTokenProvider: {
        getAccessToken: () => authClient.getAccessToken(),
      },
      endpoint: serverEndpoint,
      transport: fetchTransport,
    }),
  removeLocalAsset: async (localAccessKey) => resolveCaptureAssetRemover()(localAccessKey),
  createShell: (context) => {
    const acceptancePublisher = createDesktopAcceptancePublisher({
      accessTokenProvider: {
        getAccessToken: () => authClient.getAccessToken(),
      },
      endpoint: serverEndpoint,
      environment: process.env,
      isPackaged: app.isPackaged,
      transport: createDesktopAcceptanceHttpTransport(),
      workspaceId: context.workspaceId,
      workspaceIdVerified: context.workspaceIdVerified,
    });
    const trayIcon = nativeImage.createFromBuffer(createTrayIconPngBuffer());
    if (process.platform === 'darwin') {
      trayIcon.setTemplateImage(true);
    }

    return createDesktopShell({
      actions: {
        openAccessibilitySettings: async () => {
          await privacySettings.open('accessibility');
        },
        openScreenRecordingSettings: async () => {
          await privacySettings.open('screen_recording');
        },
        pauseCapture: async () => {
          await context.control.pause();
        },
        refreshPermissions: async () => {
          await refreshCapturePermissions({
            client: context.commandClient,
          });
        },
        requeueTerminalJobs: () => context.syncRuntime.requeueTerminalJobs(),
        resumeCapture: async () => {
          await context.control.resume();
        },
        resumeProviderSync: async () => {
          context.syncRuntime.resumeProviderSync();
        },
      },
      adapters: {
        buildMenu: (items) =>
          Menu.buildFromTemplate(
            items.map((item) => {
              if (item.kind === 'separator') {
                return { type: 'separator' as const };
              }
              return {
                click: item.click,
                enabled: item.enabled,
                label: item.label,
              };
            }),
          ),
        createTray: () => new Tray(trayIcon),
        createWindow: () =>
          new BrowserWindow({
            height: 560,
            minHeight: 420,
            minWidth: 420,
            show: false,
            title: DESKTOP_APPLICATION_NAME,
            webPreferences: {
              contextIsolation: true,
              nodeIntegration: false,
              preload: mainWindowPreloadPath,
            },
            width: 480,
          }),
        quit: () => app.quit(),
        showNotification: ({ body, title }) => {
          if (Notification.isSupported()) {
            new Notification({ body, title }).show();
          }
        },
      },
      mainWindowHtmlPath,
      statusSource: {
        async getStatus(): Promise<DesktopShellStatus> {
          const snapshot = context.control.getSnapshot();
          const permissions = snapshot.permissions;
          const workerCapacity = context.syncRuntime.getCapacityStatus();
          const syncGate = context.syncRuntime.getGateStatus();
          const sync = await createSyncQueueSummary(context.store, context.workspaceId, {
            now: new Date().toISOString(),
            workerCapacity,
          });
          const lastError = snapshot.lastSafeError;
          const admission = snapshot.admission;
          const helperStatus = snapshot.captureHelper;
          const capturePauseReason = snapshot.pauseReasons?.[0];

          const status: DesktopShellStatus = {
            accessibility: permissions.accessibility,
            captureFailureCount: snapshot.captureFailureCount,
            capturePaused: snapshot.status === 'paused',
            ...(capturePauseReason ? { capturePauseReason } : {}),
            captureAdmission: {
              active: admission.reasons.length > 0,
              reasons: [...admission.reasons],
            },
            ...(helperStatus?.policyHash && helperStatus.policyVersion
              ? {
                  capturePolicy: {
                    hash: helperStatus.policyHash,
                    version: helperStatus.policyVersion,
                  },
                }
              : {}),
            captureState: snapshot.status,
            ...(snapshot.lastHeartbeatAt ? { lastHeartbeatAt: snapshot.lastHeartbeatAt } : {}),
            ...(lastError ? { lastErrorCode: lastError.code } : {}),
            ...(lastError ? { lastErrorMessage: lastError.message } : {}),
            screenRecording: permissions.screenRecording,
            syncBlocked: sync.blocked,
            syncGate,
            syncCompletedPerMinute: sync.completedPerMinute,
            syncFailed: sync.failed,
            syncInputPerMinute: sync.inputPerMinute,
            syncLastErrorCode: sync.lastError?.code,
            syncLastErrorMessage: sync.lastError?.message,
            ...(sync.oldestActiveAgeSeconds !== undefined
              ? { syncOldestActiveAgeSeconds: sync.oldestActiveAgeSeconds }
              : {}),
            syncPending: sync.pending,
            syncProcessing: sync.processing,
            syncRetrying: sync.retrying,
            ...(sync.workerCapacity ? { syncWorkerCapacity: sync.workerCapacity } : {}),
          };
          const outboxJobs = await context.store.listOutboxJobs({
            workspaceId: context.workspaceId,
          });
          const queueProjection = projectAcceptanceQueue(outboxJobs, Date.now());
          void acceptancePublisher.tick({
            captureAdmission: {
              active: admission.reasons.length > 0,
              reasons: [...admission.reasons],
            },
            capturePaused: snapshot.status === 'paused',
            capturePauseReasons: [...(snapshot.pauseReasons ?? [])],
            captureState: snapshot.status,
            capturePolicyVersion: helperStatus?.policyVersion,
            syncInputPerMinute: sync.inputPerMinute,
            syncCompletedPerMinute: sync.completedPerMinute,
            syncProcessing: queueProjection.processing,
            syncPending: queueProjection.pending,
            ...(queueProjection.oldestActiveAgeSeconds !== undefined
              ? { syncOldestActiveAgeSeconds: queueProjection.oldestActiveAgeSeconds }
              : {}),
            safeErrorCode: queueProjection.safeErrorCode,
            syncWorkerCapacity: workerCapacity,
            syncGate,
            queue: queueProjection.queue,
            inFlight: queueProjection.inFlight,
            queueHeads: queueProjection.queueHeads,
          });
          return status;
        },
      },
    });
  },
  createStore: () => {
    const sqlitePath = prepareOperationalDatabase({
      directory: app.getPath('userData'),
      overridePath: process.env.RECAPSY_DESKTOP_SQLITE_PATH,
    });

    return createSqliteStore({
      database: createNodeSqliteDatabase(sqlitePath),
    });
  },
  hideDockIcon: devVisibilityEnabled ? false : undefined,
  ipcMain,
  loginPrompter,
  onHelperEnvelope: devVisibilityEnabled ? devVisibility.onHelperEnvelope : undefined,
  onSyncError: devVisibilityEnabled ? devVisibility.onSyncError : undefined,
  onSyncResult: devVisibilityEnabled ? devVisibility.onSyncResult : undefined,
  openExternalUrl: async (url) => {
    await shell.openExternal(url);
  },
  // Real asset-byte reader for the sync loop, replacing the runtime's
  // fail-closed default. Bound to the same `resolveCaptureAssetRoot()` the
  // capture process is handed above, so writer and reader share one root.
  readAssetBytes: (localAccessKey) => resolveCaptureAssetReader()(localAccessKey),
  resolveDeviceId: () =>
    resolveDesktopDeviceId({
      developmentOverride: developmentDeviceIdOverride,
      directory: app.getPath('userData'),
      isDevelopment: !app.isPackaged,
    }),
  storageAdmission: {
    minAvailableBytes: 512 * 1024 * 1024,
    probe: () => createLocalStorageAdmissionProbe({ assetRoot: resolveCaptureAssetRoot() })(),
    resumeAvailableBytes: 1024 * 1024 * 1024,
    verifyWrite: () => createLocalStorageWriteVerifier({ assetRoot: resolveCaptureAssetRoot() })(),
  },
  tokenStore,
};

const runtime = startDesktopSingleInstance({
  app,
  start: () => createElectronMainRuntime(runtimeOptions),
  onSecondInstance(activeRuntime) {
    void activeRuntime.ready
      .then(({ shell: desktopShell }) => desktopShell?.showMainWindow())
      .catch(() => undefined);
  },
});

runtime?.ready.catch((error: unknown) => {
  // Dev-only top-level guard so a startup failure is visible instead of a
  // silently-dead process; this is not the structured/redacted logging the
  // full runtime will eventually have.
  console.error('[recapsy-desktop] desktop runtime failed to start', error);
  app.exit(1);
});
