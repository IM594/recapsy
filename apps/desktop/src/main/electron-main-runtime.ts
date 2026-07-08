import {
  type CaptureEventSummaryDto,
  type CaptureStatusDto,
  IPC_CHANNEL_REGISTRY,
  IPC_ERROR_CODES,
  type IpcChannelName,
  type IpcError,
  type IpcErrorCode,
  type IpcResponseEnvelope,
  type RuntimeStatusDto,
  assertRendererSafeDto,
  createIpcErrorEnvelope,
  validateIpcRequest,
} from '../ipc';
import type { CaptureHelperClient, CaptureHelperState } from '../runtime/capture-helper-controller';
import { createCaptureHelperController } from '../runtime/capture-helper-controller';
import {
  type CaptureHelperCommandClient,
  type CaptureHelperEventIntake,
  createCaptureHelperEventIntake,
} from '../runtime/capture-helper-event-intake';
import { createDesktopRuntime } from '../runtime/lifecycle-controller';
import type { DesktopRuntime } from '../runtime/types';
import {
  type AssetAvailabilityCheck,
  type AssetAvailabilityResolver,
  type BackpressureConfig,
  type OperationalStoreRepository,
  type OutboxJob,
  type SafeOperationalError,
  reconcileAssetRefs,
} from '../storage';
import { createSyncQueueSummary } from '../sync/scheduler';
import { recoverInterruptedOutboxJobs } from '../sync/startup-recovery';

/**
 * Structural surface of `Electron.App` this module depends on. Kept narrow
 * and duck-typed (same pattern as `SpawnedHelperProcess` in
 * `helper/spawn-capture-helper-client.ts`) so this file's wiring logic can be
 * exercised with `bun test` against a plain fake object, while the real
 * `electron` module's `app` singleton satisfies it as-is. Only the app
 * lifecycle events this runtime actually reacts to are declared here.
 */
export type ElectronQuitEvent = {
  preventDefault(): void;
};

export type ElectronAppLike = {
  whenReady(): Promise<void>;
  on(event: 'window-all-closed', listener: () => void): unknown;
  on(event: 'before-quit', listener: (event: ElectronQuitEvent) => void): unknown;
  quit(): void;
  /** Terminates the process immediately, without re-running the quit event sequence. Used as the timeout fallback below. */
  exit(code?: number): void;
  dock?: { hide(): void } | null;
};

/**
 * Structural surface of `Electron.IpcMain` this module depends on. Real
 * `ipcMain` satisfies this as-is; tests can supply a lightweight fake that
 * just records registered handlers.
 */
export type ElectronIpcMainLike = {
  handle(
    channel: string,
    listener: (event: unknown, payload: unknown) => unknown | Promise<unknown>,
  ): unknown;
};

export type OperationalStoreLifecycle = OperationalStoreRepository & {
  initialize(): Promise<void>;
  close(): void;
};

export type ElectronMainRuntimeOptions = {
  app: ElectronAppLike;
  /** Renderer IPC surface. Omit to wire only app lifecycle (e.g. in a test harness with no renderer). */
  ipcMain?: ElectronIpcMainLike;
  /** Creates the local operational store. Injected so tests can use an in-memory store and the real entry can use `node-sqlite-driver.ts` with a dev-only path. */
  createStore(): OperationalStoreLifecycle;
  /** Creates the transport to the capture helper subprocess. Injected so tests never spawn a real process. */
  createHelperClient(): CaptureHelperClient & CaptureHelperCommandClient;
  deviceId: string;
  /**
   * V0 has no real session/workspace management wired into the Electron
   * main process yet (see the "明确不做的事" scope note this file's caller
   * documents), so the active workspace id is an injected constant rather
   * than something read from a signed-in session.
   */
  workspaceId: string;
  backpressure?: BackpressureConfig;
  now?(): string;
  /** Hide the Dock icon once the app is ready. Defaults to true; V0 has no Tray UI, so an undocked, dockless process is the least surprising default on macOS. */
  hideDockIcon?: boolean;
  /**
   * Upper bound on how long `before-quit` waits for `runtime.requestQuit()`
   * (startup recovery/helper shutdown) before forcing the process to exit
   * anyway, mirroring the timeout + force-finish pattern
   * `spawn-capture-helper-client.ts` already uses for its own child process
   * shutdown. Defaults to 5s.
   */
  quitTimeoutMs?: number;
};

export type ElectronMainRuntimeReadyState = {
  store: OperationalStoreLifecycle;
  runtime: DesktopRuntime;
  eventIntake: CaptureHelperEventIntake;
};

export type ElectronMainRuntimeHandle = {
  /** Resolves once `app.whenReady()` fired and the store/runtime/IPC wiring finished. */
  ready: Promise<ElectronMainRuntimeReadyState>;
};

const DEFAULT_BACKPRESSURE: BackpressureConfig = {
  maxAssetBytes: 25 * 1024 * 1024,
  maxQueuedJobs: 500,
  maxRetryAttempts: 8,
};

const DEFAULT_QUIT_TIMEOUT_MS = 5000;

/**
 * V0 dev helper (`helper/dev-helper-process.ts`) never touches the
 * filesystem, and the real asset lifecycle (staging file -> atomic move ->
 * manifest) is a future Swift helper responsibility. Local access keys the
 * store holds today are opaque tokens, not real paths (see
 * `safeLocalAccessKey` in `runtime/capture-helper-event-intake.ts`), so there
 * is nothing on disk this process can actually check yet. This resolver
 * documents that limitation instead of quietly faking a real filesystem
 * check; it should be replaced once a helper that writes real assets exists.
 */
const alwaysAvailableAssetResolver: AssetAvailabilityResolver = {
  checkAvailability(): Promise<AssetAvailabilityCheck> {
    return Promise.resolve({ availabilityState: 'available' });
  },
};

/**
 * Wires the already-tested business logic (SQLite operational store, capture
 * helper controller/event intake, startup recovery, asset reconciliation,
 * typed IPC) into Electron's app lifecycle. This function never imports
 * `electron` itself — see `electron-entry.ts` for the thin real entry point
 * that does — so it can run under `bun test` with fakes for `app`/`ipcMain`.
 */
export function createElectronMainRuntime(
  options: ElectronMainRuntimeOptions,
): ElectronMainRuntimeHandle {
  const now = options.now ?? (() => new Date().toISOString());
  const backpressure = options.backpressure ?? DEFAULT_BACKPRESSURE;

  if (options.hideDockIcon !== false) {
    options.app.dock?.hide();
  }

  // V0 menu-bar semantics (docs/design/ELECTRON_MAIN_RUNTIME.md "生命周期"):
  // closing the last window must not quit the app or stop capture/sync.
  // There is intentionally no listener body here beyond suppressing
  // Electron's default-app quit-on-last-window-closed behavior.
  options.app.on('window-all-closed', () => {});

  const ready: Promise<ElectronMainRuntimeReadyState> = options.app.whenReady().then(async () => {
    const store = options.createStore();
    await store.initialize();

    const helperClient = options.createHelperClient();
    const eventIntake = createCaptureHelperEventIntake({
      backpressure,
      client: helperClient,
      deviceId: options.deviceId,
      now,
      store,
      workspaceId: options.workspaceId,
    });
    const helper = createCaptureHelperController({
      client: helperClient,
      deviceId: options.deviceId,
      eventIntake,
      now,
      store,
    });

    const runtime = createDesktopRuntime({
      assetReconciliation: {
        async reconcile() {
          await reconcileAssetRefs({
            now: now(),
            resolver: alwaysAvailableAssetResolver,
            store,
            workspaceId: options.workspaceId,
          });
        },
      },
      helper,
      startupRecovery: {
        async recover() {
          await recoverInterruptedOutboxJobs({
            now: now(),
            store,
            workspaceId: options.workspaceId,
          });
        },
      },
    });

    await runtime.start();

    if (options.ipcMain) {
      registerIpcHandlers(options.ipcMain, {
        eventIntake,
        now,
        runtime,
        store,
        workspaceId: options.workspaceId,
      });
    }

    return { eventIntake, runtime, store };
  });

  // `before-quit` (rather than `will-quit`) is used because it fires
  // earliest in Electron's shutdown sequence and reliably supports
  // `preventDefault()` on every platform V0 targets; see
  // docs/design/ELECTRON_MAIN_RUNTIME.md "生命周期" for the quit contract
  // this implements: stop capture, shut the helper down, flush what it can,
  // then actually quit. `app.exit()` (not `app.quit()` again) is the actual
  // terminator so a hung `runtime.requestQuit()` cannot wedge the app open
  // forever — the same timeout + force-finish shape
  // `spawn-capture-helper-client.ts` uses for its own child process.
  const quitTimeoutMs = options.quitTimeoutMs ?? DEFAULT_QUIT_TIMEOUT_MS;
  let quitRequested = false;
  options.app.on('before-quit', (event) => {
    if (quitRequested) {
      return;
    }

    quitRequested = true;
    event.preventDefault();

    void raceWithTimeout(
      ready.then(({ runtime }) => runtime.requestQuit()).catch(() => undefined),
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

type IpcHandlerContext = {
  runtime: DesktopRuntime;
  eventIntake: CaptureHelperEventIntake;
  store: OperationalStoreRepository;
  workspaceId: string;
  now(): string;
};

type IpcHandlerFn = (
  ctx: IpcHandlerContext,
  payload: unknown,
) => Promise<IpcResponseEnvelope<unknown>>;

/**
 * Only channels with real business logic behind them in this V0 wiring are
 * implemented. Session, workspace, OCR, timeline, search, sync retry/cancel/
 * flush, settings.updateLocal/getCapabilities and diagnostics all depend on
 * capability that does not exist in this codebase yet (a signed-in session,
 * a real server API client wired into main, a diagnostics log store, etc.).
 * Rather than inventing that business logic or fabricating fake responses,
 * channels without a real handler here still get a typed `unknown` error
 * envelope (see the fallback in `registerIpcHandlers`) instead of Electron's
 * raw "no handler registered" rejection.
 */
const REAL_IPC_HANDLERS: Partial<Record<IpcChannelName, IpcHandlerFn>> = {
  'capture.getStatus': async (ctx) => toIpcSuccess(buildCaptureStatusDto(ctx)),
  'capture.getRecentEvents': async (ctx, payload) =>
    toIpcSuccess(await buildRecentEventsDto(ctx, payload as { limit?: number })),
  'capture.pause': async (ctx) => {
    await ctx.runtime.pause();
    return toIpcSuccess(buildCaptureStatusDto(ctx));
  },
  'capture.resume': async (ctx) => {
    await ctx.runtime.resume();
    return toIpcSuccess(buildCaptureStatusDto(ctx));
  },
  'settings.getRuntime': async (ctx) => toIpcSuccess(buildRuntimeStatusDto(ctx)),
  'sync.getSummary': async (ctx) =>
    toIpcSuccess(await createSyncQueueSummary(ctx.store, ctx.workspaceId)),
};

function registerIpcHandlers(ipcMain: ElectronIpcMainLike, ctx: IpcHandlerContext): void {
  for (const definition of IPC_CHANNEL_REGISTRY) {
    ipcMain.handle(definition.channel, async (_event, payload) => {
      const validation = validateIpcRequest(definition.channel, payload);

      if (!validation.ok) {
        return validation.error;
      }

      const handler = REAL_IPC_HANDLERS[definition.channel];

      if (!handler) {
        return createIpcErrorEnvelope(
          'unknown',
          `${definition.channel} has no runtime implementation in this Electron main phase.`,
        );
      }

      return handler(ctx, validation.value);
    });
  }
}

function toIpcSuccess<TData>(data: TData): IpcResponseEnvelope<TData> {
  const safety = assertRendererSafeDto(data);

  if (!safety.ok) {
    // This should never trigger for the DTOs built below; it exists as a
    // last-line-of-defense against accidentally leaking an unsafe field
    // (local path, token, etc.) to the renderer, per
    // docs/design/ELECTRON_MAIN_RUNTIME.md "Security / Config".
    return createIpcErrorEnvelope('unknown', 'Response failed renderer-safety validation.');
  }

  return { data, ok: true };
}

function buildCaptureStatusDto(ctx: IpcHandlerContext): CaptureStatusDto {
  const snapshot = ctx.runtime.getSnapshot();
  const helperStatus = snapshot.captureHelper;
  const intakeStatus = ctx.eventIntake.getStatus();
  const permissions = intakeStatus.permissions ?? {
    accessibility: 'unknown',
    screenRecording: 'unknown',
  };
  // `helperStatus.lastSafeError` (controller-driven: start/shutdown
  // failures) takes precedence over the intake's own last safe error
  // (envelope-driven: capture.error/backpressure/store failures) because a
  // controller-level failure means the helper itself is not usable, which is
  // the more actionable signal for the renderer.
  const lastSafeError = helperStatus?.lastSafeError ?? intakeStatus.lastSafeError;

  return {
    // No per-event log is wired yet; only aggregate outbox counts are
    // available today via `sync.getSummary` and `capture.getRecentEvents`.
    paused: snapshot.status === 'paused',
    permissions,
    recentEventCount: 0,
    state: toCaptureStatusState(helperStatus?.state),
    ...(lastSafeError ? { lastError: toIpcError(lastSafeError) } : {}),
  };
}

/**
 * There is no dedicated per-capture event log table yet (see
 * `docs/design/ELECTRON_MAIN_RUNTIME.md`'s `audit_event_log` as a future
 * slot). `outbox_jobs` is the closest real, already-persisted proxy for
 * "capture events observed recently" — each row originates from exactly one
 * `capture.result` envelope accepted into the outbox — so this derives the
 * DTO from there instead of returning a hardcoded empty list.
 */
async function buildRecentEventsDto(
  ctx: IpcHandlerContext,
  payload: { limit?: number },
): Promise<{ events: CaptureEventSummaryDto[] }> {
  const limit = payload.limit ?? 50;
  const jobs = await ctx.store.listOutboxJobs({ workspaceId: ctx.workspaceId });
  const events = jobs
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit)
    .map(toCaptureEventSummaryDto);

  return { events };
}

function toCaptureEventSummaryDto(job: OutboxJob): CaptureEventSummaryDto {
  const reason = job.terminalReason ?? job.lastSafeError?.code;

  return {
    id: job.id,
    observedAt: job.capture.observedAt,
    state: toCaptureEventState(job.state),
    ...(reason ? { reason } : {}),
  };
}

function toCaptureEventState(state: OutboxJob['state']): CaptureEventSummaryDto['state'] {
  switch (state) {
    case 'pending':
    case 'uploading':
    case 'ocr_wait':
    case 'synced':
      return 'accepted';
    case 'blocked':
      return 'blocked';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'skipped';
  }
}

function buildRuntimeStatusDto(ctx: IpcHandlerContext): RuntimeStatusDto {
  const snapshot = ctx.runtime.getSnapshot();
  // `lastObservedAt` is updated by `CaptureHelperEventIntake` on every
  // inbound helper envelope (hello/heartbeat/status/capture.*), so it is a
  // more accurate "is the helper actually alive" signal than the
  // controller's own `updatedAt` (which only changes on
  // start/pause/resume/shutdown transitions this process itself drove).
  const lastObservedAt = ctx.eventIntake.getStatus().lastObservedAt;

  return {
    capturePaused: snapshot.status === 'paused',
    helper: {
      status: toHelperRuntimeStatus(snapshot.captureHelper?.state),
      ...(lastObservedAt ? { lastHeartbeatAt: lastObservedAt } : {}),
    },
    menuBarActive: snapshot.menuBarActive,
    // No network reachability probe exists in this V0 wiring.
    network: 'unknown',
    status: snapshot.status,
  };
}

function toCaptureStatusState(state: CaptureHelperState | undefined): CaptureStatusDto['state'] {
  switch (state) {
    case 'running':
      return 'capturing';
    case 'paused':
      return 'paused';
    case 'failed':
    case 'exited':
      return 'degraded';
    case 'starting':
    case 'idle':
    case 'stopping':
    case 'stopped':
    case undefined:
      return 'idle';
  }
}

function toHelperRuntimeStatus(
  state: CaptureHelperState | undefined,
): RuntimeStatusDto['helper']['status'] {
  switch (state) {
    case undefined:
    case 'idle':
      return 'not_started';
    case 'starting':
      return 'starting';
    case 'running':
    case 'paused':
      return 'ready';
    case 'stopping':
    case 'stopped':
      return 'stopped';
    case 'failed':
    case 'exited':
      return 'degraded';
  }
}

function toIpcError(error: SafeOperationalError): IpcError {
  const code = (IPC_ERROR_CODES as readonly string[]).includes(error.code)
    ? (error.code as IpcErrorCode)
    : 'unknown';

  return { code, message: error.message };
}
