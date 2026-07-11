import type { AuthClient } from '../auth/auth-client';
import type { LoginPrompter } from '../auth/login-window';
import type { TokenStore } from '../auth/token-store';
import type { HelperEnvelope, HelperToMainType } from '../helper/protocol';
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
import { createSyncQueueSummary, createSyncScheduler } from '../sync/scheduler';
import { recoverInterruptedOutboxJobs } from '../sync/startup-recovery';
import {
  type SyncLoop,
  type SyncLoopOptions,
  createSyncLoop as createRealSyncLoop,
} from '../sync/sync-loop';
import type {
  RetryBackoffConfig,
  SyncAssetReader,
  SyncRunResult,
  SyncServerApi,
} from '../sync/types';

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
   * Where auth tokens live. Shared with `loginPrompter`'s own auth client
   * (the real entry point constructs one `createAuthClient(...)` and wires
   * it into both places) so a successful login and a later session check
   * always agree on the same stored token.
   */
  tokenStore: TokenStore;
  /**
   * Used once, at startup, to check whether an already-stored token still
   * maps to a real, live session (see `resolveWorkspaceId` below). Narrowed
   * to just `getActiveSession` because this file never needs to call
   * `login` itself — that only happens inside `loginPrompter`.
   */
  authClient: Pick<AuthClient, 'getActiveSession'>;
  /**
   * Shows the login window and resolves once the user has authenticated,
   * only when `authClient.getActiveSession()` could not confirm an existing
   * session. See `auth/login-window.ts`.
   */
  loginPrompter: LoginPrompter;
  /** Creates the real server API client used by the sync loop. Injected so tests never make real HTTP calls. */
  createServerApi(): SyncServerApi;
  /**
   * Reads the bytes for a local asset ref so the sync loop can upload it as
   * OCR input. Defaults to `failClosedReadAssetBytes` below: the V0 dev
   * helper (`helper/dev-helper-process.ts`) never writes real asset bytes to
   * disk, so there is nothing real to read yet (same limitation
   * `alwaysAvailableAssetResolver` documents for asset reconciliation). This
   * is injectable so a future real helper/back-end can supply real bytes
   * without changing this file's wiring.
   */
  readAssetBytes?: SyncAssetReader;
  /** Overrides the sync loop's idle/active re-schedule delays; see `sync/sync-loop.ts`. */
  syncIdleDelayMs?: number;
  syncActiveDelayMs?: number;
  /** Overrides the sync scheduler's retry budget; see `sync/scheduler.ts` and `DEFAULT_SYNC_MAX_ATTEMPTS` below. */
  syncMaxAttempts?: number;
  /** Overrides the sync scheduler's exponential-backoff policy; see `DEFAULT_SYNC_RETRY_BACKOFF` below. */
  syncRetryBackoff?: RetryBackoffConfig;
  /** Creates the self-rescheduling sync loop. Injected (defaults to the real `createSyncLoop`) so tests never start a real timer. */
  createSyncLoop?(loopOptions: SyncLoopOptions): SyncLoop;
  backpressure?: BackpressureConfig;
  now?(): string;
  /** Hide the Dock icon once the app is ready. Defaults to true; V0 has no Tray UI, so an undocked, dockless process is the least surprising default on macOS. */
  hideDockIcon?: boolean;
  /**
   * Dev-visibility hook (see `RECAPSY_DESKTOP_DEV_VISIBILITY` in
   * `electron-entry.ts`): invoked synchronously with every inbound helper
   * envelope just before it reaches `eventIntake.handleEnvelope`. Not used by
   * V0's default wiring — undefined here means no wrapping happens and
   * `eventIntake` behaves exactly as `createCaptureHelperEventIntake` built
   * it.
   */
  onHelperEnvelope?(envelope: HelperEnvelope<HelperToMainType>): void;
  /**
   * Same dev-visibility purpose as `onHelperEnvelope`, forwarded straight
   * through to the sync loop's own `onResult`/`onError` hooks (see
   * `sync/sync-loop.ts`).
   */
  onSyncResult?(result: SyncRunResult): void;
  onSyncError?(error: unknown): void;
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
  /** Resolved once at startup by `resolveWorkspaceId` — see that function's doc comment. */
  workspaceId: string;
  /**
   * `false` when this run could not re-confirm `workspaceId` against the
   * real `/v1/auth/session` route at startup (network/server unavailable)
   * and instead degraded to the last workspace id a real login or session
   * check had actually confirmed (`AuthTokenSet.workspaceId` in
   * `auth/token-store.ts`). `true` when a fresh login or a live session
   * check confirmed it this run. Surfaced so this degraded-but-running state
   * is an explicit, inspectable fact rather than a silent fallback — see
   * `resolveWorkspaceId`.
   */
  workspaceIdVerified: boolean;
  syncLoop: SyncLoop;
};

export type ElectronMainRuntimeHandle = {
  /** Resolves once `app.whenReady()` fired and the store/runtime/IPC wiring finished. */
  ready: Promise<ElectronMainRuntimeReadyState>;
};

/**
 * Sized against the actual product target (2026-07-08): captures every 2-5s,
 * at least 8h/day, ~100-800KB per compressed asset. `evaluateOperationalStoreBackpressure`
 * pauses on whichever limit is hit first, so both are sized to the same
 * worst-case tolerance window (worst-case cadence: 1 capture/2s) rather than
 * to independent, unrelated budgets:
 * - `maxAssetBytes`: 900 captures (30min / 2s) * 800KB (largest observed
 *   size) ≈ 703MB, rounded up to 750MB for margin.
 * - `maxQueuedJobs`: 900 captures in that same 30min window, rounded up to
 *   1000 so it isn't the tighter constraint under the worst-case byte
 *   assumption.
 * Still a planning estimate, not a product-confirmed SLA — revisit once
 * there is real device telemetry on sustained offline duration.
 */
const DEFAULT_BACKPRESSURE: BackpressureConfig = {
  maxAssetBytes: 750 * 1024 * 1024,
  maxQueuedJobs: 1000,
  // `maxRetryAttempts` is the backpressure decision's own attempt ceiling; it
  // mirrors `DEFAULT_SYNC_MAX_ATTEMPTS` (the scheduler's per-job budget) at 15
  // but is a separate knob — the two are intentionally not unified so they can
  // diverge if daytime tuning wants a different backpressure threshold. With
  // the exponential backoff below capping at 5 minutes, 15 attempts now spans
  // a far wider tolerance window than the old flat-60s curve, so both values
  // are candidates for retuning against real device telemetry.
  maxRetryAttempts: 15,
};

/** See `DEFAULT_BACKPRESSURE`'s `maxRetryAttempts` comment above for the shared rationale. */
const DEFAULT_SYNC_MAX_ATTEMPTS = 15;
/**
 * Exponential-backoff defaults for retryable sync failures (see
 * `docs/design/OCR_OUTBOX_STATE_MACHINE.md` §4.2): first retry ~2s, doubling
 * each attempt up to a 5-minute ceiling, with ±20% jitter to de-synchronize
 * retries across jobs/devices and spare the 2-core co-hosted server from
 * lockstep retry storms. Overridable via `ElectronMainRuntimeOptions.syncRetryBackoff`.
 */
const DEFAULT_SYNC_RETRY_BACKOFF: RetryBackoffConfig = {
  baseMs: 2000,
  factor: 2,
  maxMs: 300_000,
  jitterRatio: 0.2,
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
 * Same limitation as `alwaysAvailableAssetResolver` above, applied to the
 * sync loop's `readAssetBytes`: the V0 dev helper never writes real bytes to
 * disk, so there is nothing real to upload as OCR input yet. Rather than
 * fabricating bytes to make the sync loop "look like" it works, this fails
 * closed with the same `local_asset_unreadable` safe-error shape
 * `sync/scheduler.ts` already has dedicated, tested handling for (it maps
 * this to a terminal `blocked` outbox state, never a retry loop or a fake
 * `synced`). Replace this once a real helper/backing store can produce real
 * bytes for a `localAccessKey`.
 */
const failClosedReadAssetBytes: SyncAssetReader = async () => {
  throw Object.assign(
    new Error(
      'Real asset bytes are not available in this Electron main phase: the V0 dev helper never writes assets to disk.',
    ),
    {
      code: 'local_asset_unreadable',
      retryable: false,
      safeMessage: 'Local asset is unreadable.',
    },
  );
};

/** Result of {@link resolveWorkspaceId} — see its doc comment for what `verified` means. */
type WorkspaceIdResolution = {
  workspaceId: string;
  verified: boolean;
};

/**
 * Resolves the workspace id to run this process against. An already-stored
 * token is treated as a *hint*, not a guarantee: it is validated against the
 * real `/v1/auth/session` route (via `authClient.getActiveSession()`) so a
 * revoked/expired token cannot silently pin the app to a stale workspace id.
 *
 * - No stored token at all (never logged in) -> prompt login. No cached
 *   value exists to fall back to.
 * - Stored token, and `getActiveSession()` confirms it -> use that
 *   (verified) workspace id. `getActiveSession()` itself refreshes the
 *   cached `AuthTokenSet.workspaceId` in this case (see `auth-client.ts`).
 * - Stored token, and `getActiveSession()` returns `null` (server
 *   *confirmed* the session is unauthenticated/expired/revoked, and already
 *   cleared the token store) -> always prompt login. There is no safe
 *   cached value to fall back to here: the session is known-bad, not
 *   merely unconfirmed, so V0's offline mode (docs/specs — captures should
 *   keep working without a live connection) must not be used to bypass a
 *   confirmed sign-out.
 * - Stored token, and `getActiveSession()` *throws* (network/server
 *   unavailable — this is "cannot confirm", not "confirmed invalid") ->
 *   degrade to the last workspace id a real login or session check actually
 *   confirmed (`AuthTokenSet.workspaceId`), if one is cached. This is what
 *   lets the app keep capturing while offline instead of blocking behind a
 *   login screen the user cannot complete without a network. Only when no
 *   such cached value exists (e.g. very first run's token, saved by a
 *   `login()` before this field existed, or an edge case with no prior
 *   confirmed session) does this fall back to prompting login.
 */
async function resolveWorkspaceId(
  options: Pick<ElectronMainRuntimeOptions, 'authClient' | 'loginPrompter' | 'tokenStore'>,
): Promise<WorkspaceIdResolution> {
  const tokens = await options.tokenStore.getTokens();

  if (tokens) {
    try {
      const session = await options.authClient.getActiveSession();

      if (session) {
        return { verified: true, workspaceId: session.workspaceId };
      }

      // Confirmed unauthenticated/expired/revoked — `getActiveSession()`
      // already cleared the token store. Fall through to login below; never
      // consult `tokens.workspaceId` on this path.
    } catch {
      if (tokens.workspaceId) {
        console.warn(
          '[recapsy-desktop] could not verify the stored session at startup (network/server unavailable); continuing offline with the last confirmed workspace id',
        );
        return { verified: false, workspaceId: tokens.workspaceId };
      }
      // No cached workspace id to degrade to — fall through to login.
    }
  }

  const result = await options.loginPrompter.promptLogin();
  return { verified: true, workspaceId: result.workspaceId };
}

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
    // Resolved before anything workspace-scoped (store IO itself is not
    // workspace-scoped, but the helper/runtime/sync wiring below is) is
    // created — see `resolveWorkspaceId`'s doc comment for what "resolved"
    // means here (validated existing token, or a fresh login).
    const { workspaceId, verified: workspaceIdVerified } = await resolveWorkspaceId(options);

    const store = options.createStore();
    await store.initialize();

    const helperClient = options.createHelperClient();
    const rawEventIntake = createCaptureHelperEventIntake({
      backpressure,
      client: helperClient,
      deviceId: options.deviceId,
      now,
      store,
      workspaceId,
    });
    // Decorator: only wraps `handleEnvelope` (to fire the dev-visibility
    // hook before delegating), leaving `capture-helper-event-intake.ts`'s
    // well-tested logic completely untouched. `getStatus`/`handleProtocolResult`
    // delegate straight through unchanged. A plain object literal is used
    // instead of `{ ...rawEventIntake }` because `rawEventIntake` is a class
    // instance whose methods live on the prototype, not as own enumerable
    // properties — a spread would silently drop them.
    const eventIntake: CaptureHelperEventIntake = options.onHelperEnvelope
      ? {
          getStatus: () => rawEventIntake.getStatus(),
          handleEnvelope: async (envelope) => {
            options.onHelperEnvelope?.(envelope);
            await rawEventIntake.handleEnvelope(envelope);
          },
          handleProtocolResult: (result) => rawEventIntake.handleProtocolResult(result),
        }
      : rawEventIntake;
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
            workspaceId,
          });
        },
      },
      helper,
      startupRecovery: {
        async recover() {
          await recoverInterruptedOutboxJobs({
            api: options.createServerApi(),
            clock: { now },
            now: now(),
            store,
            workspaceId,
          });
        },
      },
    });

    await runtime.start();

    const syncScheduler = createSyncScheduler({
      api: options.createServerApi(),
      clock: { now },
      maxAttempts: options.syncMaxAttempts ?? DEFAULT_SYNC_MAX_ATTEMPTS,
      readAssetBytes: options.readAssetBytes ?? failClosedReadAssetBytes,
      retryBackoff: options.syncRetryBackoff ?? DEFAULT_SYNC_RETRY_BACKOFF,
      store,
      workspace: { getActiveWorkspaceId: async () => workspaceId },
    });
    const createLoop = options.createSyncLoop ?? createRealSyncLoop;
    const syncLoop = createLoop({
      activeDelayMs: options.syncActiveDelayMs,
      idleDelayMs: options.syncIdleDelayMs,
      onError: options.onSyncError,
      onResult: options.onSyncResult,
      scheduler: syncScheduler,
    });
    syncLoop.start();

    if (options.ipcMain) {
      registerIpcHandlers(options.ipcMain, {
        eventIntake,
        now,
        runtime,
        store,
        workspaceId,
      });
    }

    return { eventIntake, runtime, store, syncLoop, workspaceId, workspaceIdVerified };
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
      ready
        .then(({ runtime, syncLoop }) => Promise.all([runtime.requestQuit(), syncLoop.stop()]))
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
