import {
  type AuthClient,
  type LoginPrompter,
  type TokenStore,
  createSessionStartup,
} from '../auth/public';
import {
  type CaptureHelperClient,
  type CaptureHelperCommandClient,
  type CaptureHelperEventHandler,
  type CaptureLifecycle,
  createCaptureIpcHandlers,
  createCaptureRuntime,
} from '../capture/public';
import type { HelperEnvelope, HelperToMainType } from '../helper/public';
import { type ElectronIpcMainLike, registerIpcHandlers } from '../ipc/public';
import { createRuntimeIpcHandlers } from '../runtime/public';
import type { BackpressureConfig, OperationalStoreRepository } from '../storage/public';
import {
  type RetryBackoffConfig,
  type SyncAssetReader,
  type SyncLoop,
  type SyncLoopOptions,
  type SyncRunResult,
  type SyncServerApi,
  createSyncIpcHandlers,
  createSyncRuntime,
} from '../sync/public';

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

export type { ElectronIpcMainLike } from '../ipc/public';

export type OperationalStoreLifecycle = OperationalStoreRepository & {
  initialize(): Promise<void>;
  close(): void;
};

export type ElectronMainRuntimeOptions = {
  app: ElectronAppLike;
  ipcMain?: ElectronIpcMainLike;
  createStore(): OperationalStoreLifecycle;
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
};

export type ElectronMainRuntimeReadyState = {
  store: OperationalStoreLifecycle;
  lifecycle: CaptureLifecycle;
  eventHandler: CaptureHelperEventHandler;
  workspaceId: string;
  workspaceIdVerified: boolean;
  syncLoop: SyncLoop;
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

  options.app.on('window-all-closed', () => {});

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

    if (options.ipcMain) {
      registerIpcHandlers(options.ipcMain, {
        ...createCaptureIpcHandlers({
          eventHandler: captureRuntime.eventHandler,
          lifecycle: captureRuntime.lifecycle,
          store,
          workspaceId,
        }),
        ...createRuntimeIpcHandlers({
          lifecycle: captureRuntime.lifecycle,
          statusSource: {
            getLastObservedAt: () => captureRuntime.eventHandler.getStatus().lastObservedAt,
          },
        }),
        ...createSyncIpcHandlers({ store, workspaceId }),
      });
    }

    return {
      eventHandler: captureRuntime.eventHandler,
      lifecycle: captureRuntime.lifecycle,
      store,
      syncLoop: syncRuntime,
      workspaceId,
      workspaceIdVerified,
    };
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
        .then(({ lifecycle, syncLoop }) => Promise.all([lifecycle.requestQuit(), syncLoop.stop()]))
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
