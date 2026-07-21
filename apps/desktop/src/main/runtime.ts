import {
  type AuthClient,
  type LoginPrompter,
  type TokenStore,
  createSessionStartup,
} from '../auth/index';
import {
  type CaptureAdmissionController,
  type CaptureControl,
  type CaptureHistoryReader,
  type CaptureRuntimeStore,
  type CaptureStorageAdmissionOptions,
  createCaptureIpcHandlers,
  createCaptureRuntime,
} from '../capture/index';
import { createDiagnosticsIpcHandlers } from '../diagnostics/index';
import type {
  CaptureHelperClient,
  CaptureHelperCommandClient,
  HelperEnvelope,
  HelperToMainType,
} from '../helper/index';
import { type ElectronIpcMainLike, registerIpcHandlers } from '../ipc/index';
import {
  type OpenExternalUrl,
  createPermissionIpcHandlers,
  createPrivacySettingsOpener,
} from '../permissions/index';
import type { ServerApiClient, ServerApiCoverageClient } from '../server/index';
import type { DesktopShell } from '../shell/index';
import type {
  AssetAvailabilityResolver,
  BackpressureConfig,
  HistoricalAssetReconciliation,
  LocalRetentionExecutionStore,
  StoreLifecycle,
} from '../storage/index';
import {
  type CoverageSyncDriver,
  type RetryBackoffConfig,
  type SyncAssetReader,
  type SyncLoop,
  type SyncLoopOptions,
  type SyncQueueStore,
  type SyncRunResult,
  type SyncServerApi,
  createCoverageSyncDriver,
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
  LocalRetentionExecutionStore &
  SyncQueueStore;

export type DesktopShellFactoryContext = {
  commandClient: CaptureHelperCommandClient;
  control: CaptureControl;
  store: DesktopStore;
  syncRuntime: SyncLoop & { getCapacityStatus(): import('../sync/index').SyncWorkerCapacityStatus };
  workspaceId: string;
  workspaceIdVerified: boolean;
};

export type ElectronMainRuntimeOptions = {
  app: ElectronAppLike;
  assetResolver?: AssetAvailabilityResolver;
  ipcMain?: ElectronIpcMainLike;
  createStore(): DesktopStore;
  createHelperClient(): CaptureHelperClient & CaptureHelperCommandClient;
  resolveDeviceId(): string | Promise<string>;
  tokenStore: TokenStore;
  authClient: Pick<AuthClient, 'getActiveSession'>;
  loginPrompter: LoginPrompter;
  createServerApi(): SyncServerApi &
    Pick<ServerApiClient, 'getCapturePolicies'> &
    ServerApiCoverageClient;
  readAssetBytes?: SyncAssetReader;
  removeLocalAsset?(localAccessKey: string): Promise<void>;
  syncIdleDelayMs?: number;
  syncActiveDelayMs?: number;
  syncLocalMaxWorkers?: number;
  syncMaxAttempts?: number;
  syncRetryBackoff?: RetryBackoffConfig;
  storageAdmission?: CaptureStorageAdmissionOptions;
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
  control: CaptureControl;
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

  let admission: CaptureAdmissionController | undefined;
  let historicalAssetReconciliation: HistoricalAssetReconciliation | undefined;
  let coverageSyncDriver: CoverageSyncDriver | undefined;
  const ready: Promise<ElectronMainRuntimeReadyState> = options.app.whenReady().then(async () => {
    const deviceId = await options.resolveDeviceId();
    const sessionStartup = createSessionStartup({
      authClient: options.authClient,
      loginPrompter: options.loginPrompter,
      tokenStore: options.tokenStore,
    });
    const { workspaceId, verified: workspaceIdVerified } = await sessionStartup.resolveWorkspace();

    const store = options.createStore();
    await store.initialize();

    let serverMaxConcurrentOcr = 1;
    const syncRuntime = createSyncRuntime({
      activeDelayMs: options.syncActiveDelayMs,
      createLoop: options.createSyncLoop,
      createServerApi: options.createServerApi,
      idleDelayMs: options.syncIdleDelayMs,
      maxAttempts: options.syncMaxAttempts,
      localMaxWorkers: options.syncLocalMaxWorkers,
      now,
      onError: options.onSyncError,
      onResult: (result) => {
        options.onSyncResult?.(result);
        void admission?.reconcile();
      },
      readAssetBytes: options.readAssetBytes,
      retryBackoff: options.syncRetryBackoff,
      resolveServerMaxConcurrentOcr: () => serverMaxConcurrentOcr,
      store,
      workspaceId,
    });
    const captureRuntime = createCaptureRuntime({
      assetResolver: options.assetResolver,
      backpressure: options.backpressure,
      client: options.createHelperClient(),
      deviceId,
      now,
      onHelperEnvelope: options.onHelperEnvelope,
      onPolicyActivated: ({ maxConcurrentOcr }) => {
        serverMaxConcurrentOcr = maxConcurrentOcr;
        syncRuntime.updateServerMaxConcurrentOcr(maxConcurrentOcr);
      },
      policyApi: options.createServerApi(),
      startupRecovery: syncRuntime,
      storageAdmission: options.storageAdmission,
      store,
      workspaceId,
    });
    admission = captureRuntime.admission;
    historicalAssetReconciliation = captureRuntime.historicalAssetReconciliation;
    coverageSyncDriver = createCoverageSyncDriver({
      api: options.createServerApi(),
      deviceId,
      onError: options.onSyncError,
      store,
      workspaceId,
    });

    const shell = options.createShell
      ? await options.createShell({
          commandClient: captureRuntime.commandClient,
          control: captureRuntime.control,
          store,
          syncRuntime,
          workspaceId,
          workspaceIdVerified,
        })
      : undefined;

    // Admission is evaluated before helper startup. A persisted high watermark
    // must prevent the native timer from producing a frame before the first
    // control transition is known.
    await captureRuntime.admission.reconcile();

    let helperStarted = false;
    try {
      await captureRuntime.control.start();
      helperStarted = true;
    } catch (error) {
      const helperStatus = captureRuntime.control.getSnapshot().captureHelper;
      // A failing helper is an actionable desktop condition, not a reason to
      // terminate before the user can see the tray state or receive a macOS
      // notification. Other startup failures remain fail-closed and surface to
      // the caller unchanged.
      if (!shell || helperStatus?.lastSafeError?.code !== 'helper_start_failed') {
        throw error;
      }
    }
    if (helperStarted) {
      captureRuntime.historicalAssetReconciliation.start();
    }
    await captureRuntime.admission.start();
    syncRuntime.start();
    coverageSyncDriver?.start();
    // Shell construction starts its own initial refresh before capture startup
    // settles. Refresh once more so a classified startup failure is immediately
    // visible instead of waiting for the next periodic poll.
    await shell?.refresh();

    if (options.ipcMain) {
      const privacySettings = createPrivacySettingsOpener(
        options.openExternalUrl ?? (async () => undefined),
      );

      registerIpcHandlers(options.ipcMain, {
        ...createCaptureIpcHandlers({
          control: captureRuntime.control,
          policy: captureRuntime.policy,
          store,
          workspaceId,
        }),
        ...createSyncIpcHandlers({
          getWorkerCapacity: () => syncRuntime.getCapacityStatus(),
          now,
          store,
          workspaceId,
        }),
        ...createDiagnosticsIpcHandlers({
          now,
          removeAsset:
            options.removeLocalAsset ??
            (async () => {
              throw new Error('Local asset cleanup is unavailable.');
            }),
          store,
          workspaceId,
        }),
        ...createPermissionIpcHandlers({
          client: captureRuntime.commandClient,
          statusSource: captureRuntime.control,
          privacySettings,
        }),
      });
    }

    return {
      commandClient: captureRuntime.commandClient,
      control: captureRuntime.control,
      ...(shell ? { shell } : {}),
      store,
      syncLoop: syncRuntime,
      workspaceId,
      workspaceIdVerified,
    };
  });

  options.app.on('window-all-closed', () => {
    void ready.then(({ control }) => control.handleLastWindowClosed()).catch(() => undefined);
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
        .then(({ control, shell, syncLoop }) => {
          return Promise.allSettled([
            Promise.resolve().then(() => historicalAssetReconciliation?.stop()),
            Promise.resolve().then(() => shell?.dispose()),
            Promise.resolve().then(() => control.requestQuit()),
            Promise.resolve().then(() => admission?.stop()),
            Promise.resolve().then(() => coverageSyncDriver?.stop()),
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
