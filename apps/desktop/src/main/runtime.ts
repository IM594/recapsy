import {
  type AuthClient,
  type LoginPrompter,
  type TokenStore,
  createSessionStartup,
} from '../auth/index';
import {
  type CaptureHelperClient,
  type CaptureHelperCommandClient,
  type CaptureHelperEventHandler,
  type CaptureHistoryReader,
  type CaptureLifecycle,
  type CaptureRuntimeStore,
  createCaptureIpcHandlers,
  createCaptureRuntime,
} from '../capture/index';
import type { HelperEnvelope, HelperToMainType } from '../helper/index';
import {
  type ElectronIpcMainLike,
  createRendererSafeSuccess,
  registerIpcHandlers,
} from '../ipc/index';
import {
  type OpenExternalUrl,
  createPermissionIpcHandlers,
  createPrivacySettingsOpener,
} from '../permissions/index';
import type { DesktopShell } from '../shell/index';
import { createStatusHandlers } from '../status/index';
import type { BackpressureConfig, StoreLifecycle } from '../storage/index';
import {
  type RetryBackoffConfig,
  type SyncAssetReader,
  type SyncLoop,
  type SyncLoopOptions,
  type SyncQueueStore,
  type SyncRunResult,
  type SyncServerApi,
  createSyncIpcHandlers,
  createSyncRuntime,
} from '../sync/index';

export type ElectronQuitEvent = {
  preventDefault(): void;
};

export type ElectronAppLike = {
  whenReady(): Promise<void>;
  on(event: 'window-all-closed', listener: () => void): unknown;
  on(event: 'before-quit', listener: (event: ElectronQuitEvent) => void): unknown;
  quit(): void;
  exit(code?: number): void;
  dock?: { hide(): void } | null;
};

export type { ElectronIpcMainLike } from '../ipc/index';

export type DesktopStore = StoreLifecycle &
  CaptureRuntimeStore &
  CaptureHistoryReader &
  SyncQueueStore;

export type DesktopShellFactoryContext = {
  commandClient: CaptureHelperCommandClient;
  eventHandler: CaptureHelperEventHandler;
  lifecycle: CaptureLifecycle;
  store: DesktopStore;
  workspaceId: string;
};

export type ElectronMainRuntimeOptions = {
  app: ElectronAppLike;
  ipcMain?: ElectronIpcMainLike;
  createStore(): DesktopStore;
  createHelperClient(): CaptureHelperClient & CaptureHelperCommandClient;
  deviceId: string;
  tokenStore: TokenStore;
  authClient: Pick<AuthClient, 'getActiveSession'>;
  loginPrompter: LoginPrompter;
  createServerApi(): SyncServerApi;
  readAssetBytes?: SyncAssetReader;
  syncIdleDelayMs?: number;
  syncActiveDelayMs?: number;
  syncMaxAttempts?: number;
  syncRetryBackoff?: RetryBackoffConfig;
  createSyncLoop?(loopOptions: SyncLoopOptions): SyncLoop;
  backpressure?: BackpressureConfig;
  now?(): string;
  hideDockIcon?: boolean;
  onHelperEnvelope?(envelope: HelperEnvelope<HelperToMainType>): void;
  onSyncResult?(result: SyncRunResult): void;
  onSyncError?(error: unknown): void;
  quitTimeoutMs?: number;
  openExternalUrl?: OpenExternalUrl;
  createShell?(context: DesktopShellFactoryContext): DesktopShell | Promise<DesktopShell>;
};

export type ElectronMainRuntimeReadyState = {
  store: DesktopStore;
  lifecycle: CaptureLifecycle;
  eventHandler: CaptureHelperEventHandler;
  commandClient: CaptureHelperCommandClient;
  workspaceId: string;
  workspaceIdVerified: boolean;
  syncLoop: SyncLoop;
  shell?: DesktopShell;
};

export type ElectronMainRuntimeHandle = {
  ready: Promise<ElectronMainRuntimeReadyState>;
};

const DEFAULT_QUIT_TIMEOUT_MS = 5000;

/**
 * Coordinates Electron application lifecycle around capability-owned
 * factories. Concrete Electron, HTTP, SQLite, and helper adapters are
 * created by `electron-entry.ts`; business startup and IPC projections stay
 * inside their owning capabilities.
 */
export function createElectronMainRuntime(
  options: ElectronMainRuntimeOptions,
): ElectronMainRuntimeHandle {
  const now = options.now ?? (() => new Date().toISOString());

  if (options.hideDockIcon !== false) {
    options.app.dock?.hide();
  }

  const ready: Promise<ElectronMainRuntimeReadyState> = options.app.whenReady().then(async () => {
    const sessionStartup = createSessionStartup({
      authClient: options.authClient,
      loginPrompter: options.loginPrompter,
      tokenStore: options.tokenStore,
    });
    const { workspaceId, verified: workspaceIdVerified } = await sessionStartup.resolveWorkspace();

    const store = options.createStore();
    await store.initialize();

    const syncRuntime = createSyncRuntime({
      activeDelayMs: options.syncActiveDelayMs,
      createLoop: options.createSyncLoop,
      createServerApi: options.createServerApi,
      idleDelayMs: options.syncIdleDelayMs,
      maxAttempts: options.syncMaxAttempts,
      now,
      onError: options.onSyncError,
      onResult: options.onSyncResult,
      readAssetBytes: options.readAssetBytes,
      retryBackoff: options.syncRetryBackoff,
      store,
      workspaceId,
    });
    const captureRuntime = createCaptureRuntime({
      backpressure: options.backpressure,
      client: options.createHelperClient(),
      deviceId: options.deviceId,
      now,
      onHelperEnvelope: options.onHelperEnvelope,
      startupRecovery: syncRuntime,
      store,
      workspaceId,
    });

    await captureRuntime.lifecycle.start();
    syncRuntime.start();

    const shell = options.createShell
      ? await options.createShell({
          commandClient: captureRuntime.commandClient,
          eventHandler: captureRuntime.eventHandler,
          lifecycle: captureRuntime.lifecycle,
          store,
          workspaceId,
        })
      : undefined;

    if (options.ipcMain) {
      const privacySettings = createPrivacySettingsOpener(
        options.openExternalUrl ?? (async () => undefined),
      );

      registerIpcHandlers(options.ipcMain, {
        ...createCaptureIpcHandlers({
          eventHandler: captureRuntime.eventHandler,
          lifecycle: captureRuntime.lifecycle,
          store,
          workspaceId,
        }),
        ...createStatusHandlers({
          lifecycle: captureRuntime.lifecycle,
          statusSource: {
            getLastObservedAt: () => captureRuntime.eventHandler.getStatus().lastObservedAt,
          },
        }),
        ...createSyncIpcHandlers({ store, workspaceId }),
        ...createPermissionIpcHandlers({
          client: captureRuntime.commandClient,
          eventHandler: captureRuntime.eventHandler,
          now,
          privacySettings,
        }),
        ...(shell
          ? {
              'app.showMainWindow': async () =>
                createRendererSafeSuccess(await shell.showMainWindow()),
            }
          : {}),
      });
    }

    return {
      commandClient: captureRuntime.commandClient,
      eventHandler: captureRuntime.eventHandler,
      lifecycle: captureRuntime.lifecycle,
      ...(shell ? { shell } : {}),
      store,
      syncLoop: syncRuntime,
      workspaceId,
      workspaceIdVerified,
    };
  });

  options.app.on('window-all-closed', () => {
    void ready.then(({ lifecycle }) => lifecycle.handleLastWindowClosed()).catch(() => undefined);
  });

  const quitTimeoutMs = options.quitTimeoutMs ?? DEFAULT_QUIT_TIMEOUT_MS;
  let quitRequested = false;
  options.app.on('before-quit', (event) => {
    if (quitRequested) {
      return;
    }

    quitRequested = true;
    event.preventDefault();

    void raceWithTimeout(
      ready
        .then(({ lifecycle, shell, syncLoop }) => {
          return Promise.allSettled([
            Promise.resolve().then(() => shell?.dispose()),
            Promise.resolve().then(() => lifecycle.requestQuit()),
            Promise.resolve().then(() => syncLoop.stop()),
          ]);
        })
        .catch(() => undefined),
      quitTimeoutMs,
    ).then(() => options.app.exit(0));
  });

  return { ready };
}

function raceWithTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve();
      }
    }, timeoutMs);

    promise
      .catch(() => undefined)
      .finally(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });
  });
}
