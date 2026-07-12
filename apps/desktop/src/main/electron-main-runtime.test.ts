import { describe, expect, it } from 'bun:test';
import type { AuthActiveSession, AuthClient } from '../auth/auth-client';
import type { LoginPromptResult, LoginPrompter } from '../auth/login-window';
import { createInMemoryTokenStore } from '../auth/token-store';
import type { HelperEnvelope, HelperToMainType, MainToHelperType } from '../helper/protocol';
import type {
  CaptureHelperClient,
  CaptureHelperStartOptions,
} from '../runtime/capture-helper-controller';
import type { CaptureHelperCommandClient } from '../runtime/capture-helper-event-intake';
import { type OperationalStoreRepository, createInMemoryOperationalStore } from '../storage';
import type { SyncLoop, SyncLoopOptions } from '../sync/sync-loop';
import type { SyncRunResult, SyncServerApi } from '../sync/types';
import {
  type ElectronAppLike,
  type ElectronIpcMainLike,
  type ElectronMainRuntimeOptions,
  type ElectronQuitEvent,
  type OperationalStoreLifecycle,
  createElectronMainRuntime,
} from './electron-main-runtime';

const now = '2026-07-08T00:00:00.000Z';
const workspaceId = 'workspace_dev';
const deviceId = 'device_dev';

describe('electron main runtime wiring', () => {
  it('registers a no-op window-all-closed listener and never quits on last window close', async () => {
    const { app, ipcMain, helperClient, store } = harness();
    createElectronMainRuntime(baseOptions({ app, helperClient, ipcMain, store }));

    app.emitWindowAllClosed();

    expect(app.quitCalls).toBe(0);
    expect(app.exitCalls).toEqual([]);
  });

  it('hides the Dock icon by default when available', () => {
    const { app, ipcMain, helperClient, store } = harness();
    createElectronMainRuntime(baseOptions({ app, helperClient, ipcMain, store }));

    expect(app.dockHideCalls).toBe(1);
  });

  it('does not hide the Dock icon when hideDockIcon is explicitly false', () => {
    const { app, ipcMain, helperClient, store } = harness();
    createElectronMainRuntime(
      baseOptions({ app, helperClient, hideDockIcon: false, ipcMain, store }),
    );

    expect(app.dockHideCalls).toBe(0);
  });

  it('does not throw when the app has no dock (non-macOS shape)', () => {
    const app = new FakeElectronApp({ withDock: false });
    const { ipcMain, helperClient, store } = harness();

    expect(() =>
      createElectronMainRuntime(baseOptions({ app, helperClient, ipcMain, store })),
    ).not.toThrow();
  });

  it('initializes the store and starts the helper client once app.whenReady() resolves', async () => {
    const { app, ipcMain, helperClient, store } = harness();
    const handle = createElectronMainRuntime(baseOptions({ app, helperClient, ipcMain, store }));

    expect(helperClient.startCalls).toBe(0);

    app.triggerReady();
    await handle.ready;

    expect(store.initializeCalls).toBe(1);
    expect(helperClient.startCalls).toBe(1);
  });

  it('before-quit prevents the default quit, awaits runtime shutdown, then force-exits', async () => {
    const { app, ipcMain, helperClient, store } = harness();
    const handle = createElectronMainRuntime(baseOptions({ app, helperClient, ipcMain, store }));
    app.triggerReady();
    await handle.ready;

    let resolveStop: () => void = () => {};
    helperClient.stopImpl = () =>
      new Promise((resolve) => {
        resolveStop = resolve;
      });

    const event = new FakeQuitEvent();
    app.emitBeforeQuit(event);
    await flushMicrotasks();

    expect(event.preventedDefault).toBe(true);
    expect(helperClient.stopCalls).toBe(1);
    expect(app.exitCalls).toEqual([]);

    resolveStop();
    await flushMicrotasks();

    expect(app.exitCalls).toEqual([0]);
  });

  it('only runs the graceful quit sequence once even if before-quit fires again', async () => {
    const { app, ipcMain, helperClient, store } = harness();
    const handle = createElectronMainRuntime(baseOptions({ app, helperClient, ipcMain, store }));
    app.triggerReady();
    await handle.ready;

    app.emitBeforeQuit(new FakeQuitEvent());
    await flushMicrotasks();
    app.emitBeforeQuit(new FakeQuitEvent());
    await flushMicrotasks();

    expect(helperClient.stopCalls).toBe(1);
    expect(app.exitCalls).toEqual([0]);
  });

  it('force-exits once the quit timeout elapses even if the helper never finishes stopping', async () => {
    const { app, ipcMain, helperClient, store } = harness();
    helperClient.stopImpl = () => new Promise(() => {});
    const handle = createElectronMainRuntime(
      baseOptions({ app, helperClient, ipcMain, quitTimeoutMs: 5, store }),
    );
    app.triggerReady();
    await handle.ready;

    app.emitBeforeQuit(new FakeQuitEvent());
    await sleep(30);

    expect(app.exitCalls).toEqual([0]);
  });

  it('registers every contract channel, with real handlers for the implemented subset', async () => {
    const { app, ipcMain, helperClient, store } = harness();
    const handle = createElectronMainRuntime(baseOptions({ app, helperClient, ipcMain, store }));
    app.triggerReady();
    await handle.ready;

    expect(ipcMain.handlers.has('session.getCurrent')).toBe(true);
    expect(ipcMain.handlers.has('capture.getStatus')).toBe(true);
    expect(ipcMain.handlers.size).toBeGreaterThan(10);
  });

  it('returns a typed unknown error for channels with no runtime implementation in this phase', async () => {
    const { app, ipcMain, helperClient, store } = harness();
    const handle = createElectronMainRuntime(baseOptions({ app, helperClient, ipcMain, store }));
    app.triggerReady();
    await handle.ready;

    const response = await ipcMain.invoke('session.getCurrent', undefined);

    expect(response).toMatchObject({ error: { code: 'unknown' }, ok: false });
  });

  it('capture.getStatus reflects helper state and permissions observed through the real intake', async () => {
    const { app, ipcMain, helperClient, store } = harness();
    const handle = createElectronMainRuntime(baseOptions({ app, helperClient, ipcMain, store }));
    app.triggerReady();
    await handle.ready;

    await helperClient.emit({
      correlationId: null,
      messageId: 'perm_1',
      payload: { accessibility: 'granted', observedAt: now, screenCapture: 'granted' },
      protocolVersion: 'recapsy.capture-helper',
      sentAt: now,
      type: 'permission.status',
    });

    const response = await ipcMain.invoke('capture.getStatus', undefined);

    expect(response).toMatchObject({
      data: {
        paused: false,
        permissions: { accessibility: 'granted', screenRecording: 'granted' },
        state: 'capturing',
      },
      ok: true,
    });
  });

  it('capture.pause and capture.resume call through to the helper client', async () => {
    const { app, ipcMain, helperClient, store } = harness();
    const handle = createElectronMainRuntime(baseOptions({ app, helperClient, ipcMain, store }));
    app.triggerReady();
    await handle.ready;

    const pauseResponse = await ipcMain.invoke('capture.pause', undefined);
    const resumeResponse = await ipcMain.invoke('capture.resume', undefined);

    expect(helperClient.pauseCalls).toBe(1);
    expect(helperClient.resumeCalls).toBe(1);
    expect(pauseResponse).toMatchObject({ data: { paused: true, state: 'paused' }, ok: true });
    expect(resumeResponse).toMatchObject({ data: { paused: false, state: 'capturing' }, ok: true });
  });

  it('rejects invalid capture.getRecentEvents payloads via schema validation', async () => {
    const { app, ipcMain, helperClient, store } = harness();
    const handle = createElectronMainRuntime(baseOptions({ app, helperClient, ipcMain, store }));
    app.triggerReady();
    await handle.ready;

    const response = await ipcMain.invoke('capture.getRecentEvents', { limit: 0 });

    expect(response).toMatchObject({ error: { code: 'validation_failed' }, ok: false });
  });

  it('maps a real capture.result envelope through to sync.getSummary and capture.getRecentEvents', async () => {
    const { app, ipcMain, helperClient, store } = harness();
    const handle = createElectronMainRuntime(baseOptions({ app, helperClient, ipcMain, store }));
    app.triggerReady();
    await handle.ready;

    await helperClient.emit({
      correlationId: null,
      messageId: 'cap_1',
      payload: {
        assets: [
          { hash: 'h1', mimeType: 'image/png', ref: 'asset_1', role: 'screenshot', sizeBytes: 10 },
        ],
        captureId: 'cap_1',
        context: { observedAt: now, policy: { decision: 'allow', version: 'v1' } },
        manifest: {
          hash: 'h1',
          mimeType: 'application/json',
          ref: 'manifest_1',
          role: 'manifest',
          sizeBytes: 0,
        },
        observedAt: now,
      },
      protocolVersion: 'recapsy.capture-helper',
      sentAt: now,
      type: 'capture.result',
    });

    const summary = await ipcMain.invoke('sync.getSummary', undefined);
    expect(summary).toMatchObject({ data: { pending: 1 }, ok: true });

    const recent = await ipcMain.invoke('capture.getRecentEvents', undefined);
    expect(recent).toMatchObject({
      data: { events: [{ id: 'cap_1', state: 'accepted' }] },
      ok: true,
    });

    // The controller/intake must have acked the capture back to the helper
    // over the same command channel real captures use.
    expect(helperClient.sentCommands.some((command) => command.type === 'capture.ack')).toBe(true);
  });

  it('skips the login prompt and resolves the workspace id from an already-valid session', async () => {
    const { app, ipcMain, helperClient, store, loginPrompter } = harness();
    const handle = createElectronMainRuntime(
      baseOptions({ app, helperClient, ipcMain, loginPrompter, store }),
    );
    app.triggerReady();
    const state = await handle.ready;

    expect(loginPrompter.promptCalls).toBe(0);
    expect(state.workspaceId).toBe(workspaceId);
    expect(state.workspaceIdVerified).toBe(true);
  });

  it('prompts login when there is no stored token, and uses the resulting workspace id', async () => {
    const { app, ipcMain, helperClient, store, loginPrompter } = harness();
    loginPrompter.result = { workspaceId: 'workspace_from_login' };
    const handle = createElectronMainRuntime(
      baseOptions({
        app,
        authClient: fakeAuthClient({ throws: new Error('should not be called: no stored token') }),
        helperClient,
        ipcMain,
        loginPrompter,
        store,
        tokenStore: createInMemoryTokenStore(null),
      }),
    );
    app.triggerReady();
    const state = await handle.ready;

    expect(loginPrompter.promptCalls).toBe(1);
    expect(state.workspaceId).toBe('workspace_from_login');
    expect(state.workspaceIdVerified).toBe(true);
  });

  it('prompts login when a stored token no longer maps to an active session, ignoring any cached workspace id', async () => {
    const { app, ipcMain, helperClient, store, loginPrompter } = harness();
    loginPrompter.result = { workspaceId: 'workspace_from_login' };
    const handle = createElectronMainRuntime(
      baseOptions({
        app,
        authClient: fakeAuthClient({ returnsNull: true }),
        helperClient,
        ipcMain,
        loginPrompter,
        store,
        // Seeded with a cached workspace id from some earlier confirmed
        // session, to prove a *confirmed* 401/expired/revoked session (the
        // `returnsNull` behavior below) always forces a fresh login and
        // never falls back to this cached value — unlike the
        // "cannot confirm" (thrown) case covered separately below.
        tokenStore: createInMemoryTokenStore({
          accessToken: 'access-token-1',
          workspaceId: 'workspace_stale_cached',
        }),
      }),
    );
    app.triggerReady();
    const state = await handle.ready;

    expect(loginPrompter.promptCalls).toBe(1);
    expect(state.workspaceId).toBe('workspace_from_login');
    expect(state.workspaceIdVerified).toBe(true);
  });

  it('prompts login when validating the stored token fails (offline/server error) and no workspace id is cached', async () => {
    const { app, ipcMain, helperClient, store, loginPrompter } = harness();
    loginPrompter.result = { workspaceId: 'workspace_from_login' };
    const handle = createElectronMainRuntime(
      baseOptions({
        app,
        authClient: fakeAuthClient({ throws: new Error('offline') }),
        helperClient,
        ipcMain,
        loginPrompter,
        store,
        // Default `baseOptions` token store has an `accessToken` but no
        // cached `workspaceId` (e.g. never seen a real server response
        // before) — the offline degradation has nothing to fall back to, so
        // this must still prompt login rather than starting with no
        // workspace id at all.
        tokenStore: createInMemoryTokenStore({ accessToken: 'access-token-1' }),
      }),
    );
    app.triggerReady();
    const state = await handle.ready;

    expect(loginPrompter.promptCalls).toBe(1);
    expect(state.workspaceId).toBe('workspace_from_login');
    expect(state.workspaceIdVerified).toBe(true);
  });

  it('degrades to the cached workspace id instead of prompting login when the session check fails but a prior real session was confirmed', async () => {
    const { app, ipcMain, helperClient, store, loginPrompter } = harness();
    const originalWarn = console.warn;
    const warnCalls: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };

    try {
      const handle = createElectronMainRuntime(
        baseOptions({
          app,
          authClient: fakeAuthClient({ throws: new Error('offline') }),
          helperClient,
          ipcMain,
          loginPrompter,
          store,
          tokenStore: createInMemoryTokenStore({
            accessToken: 'access-token-1',
            workspaceId: 'workspace_cached_offline',
          }),
        }),
      );
      app.triggerReady();
      const state = await handle.ready;

      expect(loginPrompter.promptCalls).toBe(0);
      expect(state.workspaceId).toBe('workspace_cached_offline');
      expect(state.workspaceIdVerified).toBe(false);
      expect(warnCalls.length).toBeGreaterThan(0);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('starts the sync loop once ready and stops it as part of the graceful quit sequence', async () => {
    const { app, ipcMain, helperClient, store, syncLoop } = harness();
    const handle = createElectronMainRuntime(
      baseOptions({ app, helperClient, ipcMain, store, syncLoop }),
    );
    app.triggerReady();
    await handle.ready;

    expect(syncLoop.startCalls).toBe(1);
    expect(syncLoop.stopCalls).toBe(0);

    app.emitBeforeQuit(new FakeQuitEvent());
    await flushMicrotasks();

    expect(syncLoop.stopCalls).toBe(1);
  });

  it('invokes onHelperEnvelope with the same envelope before it reaches the real intake', async () => {
    const { app, ipcMain, helperClient, store } = harness();
    const receivedEnvelopes: HelperEnvelope<HelperToMainType>[] = [];
    const handle = createElectronMainRuntime(
      baseOptions({
        app,
        helperClient,
        ipcMain,
        onHelperEnvelope: (envelope) => {
          receivedEnvelopes.push(envelope);
        },
        store,
      }),
    );
    app.triggerReady();
    await handle.ready;

    const envelope: HelperEnvelope<HelperToMainType> = {
      correlationId: null,
      messageId: 'perm_1',
      payload: { accessibility: 'granted', observedAt: now, screenCapture: 'granted' },
      protocolVersion: 'recapsy.capture-helper',
      sentAt: now,
      type: 'permission.status',
    };
    await helperClient.emit(envelope);

    expect(receivedEnvelopes).toEqual([envelope]);

    // The wrapper must still delegate to the real (well-tested) intake —
    // this envelope should be reflected in capture.getStatus exactly as it
    // would be without onHelperEnvelope wired up.
    const response = await ipcMain.invoke('capture.getStatus', undefined);
    expect(response).toMatchObject({
      data: { permissions: { accessibility: 'granted', screenRecording: 'granted' } },
      ok: true,
    });
  });

  it('does not wrap the event intake when onHelperEnvelope is not supplied', async () => {
    const { app, ipcMain, helperClient, store } = harness();
    const handle = createElectronMainRuntime(baseOptions({ app, helperClient, ipcMain, store }));
    app.triggerReady();
    await handle.ready;

    // No onHelperEnvelope wired up; a real envelope must still flow through
    // to the intake exactly as today (no behavior change when the dev flag
    // is off).
    await helperClient.emit({
      correlationId: null,
      messageId: 'perm_1',
      payload: { accessibility: 'granted', observedAt: now, screenCapture: 'granted' },
      protocolVersion: 'recapsy.capture-helper',
      sentAt: now,
      type: 'permission.status',
    });

    const response = await ipcMain.invoke('capture.getStatus', undefined);
    expect(response).toMatchObject({
      data: { permissions: { accessibility: 'granted', screenRecording: 'granted' } },
      ok: true,
    });
  });

  it('forwards onSyncResult/onSyncError to the injected createSyncLoop', async () => {
    const { app, ipcMain, helperClient, store } = harness();
    let capturedOptions: SyncLoopOptions | undefined;
    const fakeLoop = new FakeSyncLoop();
    const onSyncResult = (_result: SyncRunResult): void => {};
    const onSyncError = (_error: unknown): void => {};

    const handle = createElectronMainRuntime({
      ...baseOptions({ app, helperClient, ipcMain, store }),
      createSyncLoop: (loopOptions) => {
        capturedOptions = loopOptions;
        return fakeLoop;
      },
      onSyncError,
      onSyncResult,
    });
    app.triggerReady();
    await handle.ready;

    expect(capturedOptions?.onResult).toBe(onSyncResult);
    expect(capturedOptions?.onError).toBe(onSyncError);
  });
});

type Harness = {
  app: FakeElectronApp;
  ipcMain: FakeIpcMain;
  helperClient: FakeHelperClient;
  store: OperationalStoreLifecycle & { initializeCalls: number; closeCalls: number };
  loginPrompter: FakeLoginPrompter;
  syncLoop: FakeSyncLoop;
};

function harness(): Harness {
  return {
    app: new FakeElectronApp(),
    helperClient: new FakeHelperClient(),
    ipcMain: new FakeIpcMain(),
    loginPrompter: new FakeLoginPrompter(),
    store: testStore(),
    syncLoop: new FakeSyncLoop(),
  };
}

function baseOptions(
  overrides: Partial<ElectronMainRuntimeOptions> & {
    app: FakeElectronApp;
    ipcMain: FakeIpcMain;
    helperClient: FakeHelperClient;
    store: OperationalStoreLifecycle;
    loginPrompter?: LoginPrompter;
    syncLoop?: FakeSyncLoop;
  },
): ElectronMainRuntimeOptions {
  const { helperClient, loginPrompter, syncLoop, ...rest } = overrides;
  const resolvedLoginPrompter = loginPrompter ?? new FakeLoginPrompter();
  const resolvedSyncLoop = syncLoop ?? new FakeSyncLoop();

  return {
    // A pre-seeded token plus an `authClient` that always confirms it as
    // valid means `resolveWorkspaceId` returns `workspaceId` without ever
    // calling `loginPrompter` — the login flow itself is covered by its own
    // dedicated tests below.
    authClient: fakeAuthClient({ workspaceId }),
    createHelperClient: () => helperClient,
    createServerApi: () => notImplementedServerApi(),
    createStore: () => rest.store,
    createSyncLoop: (_loopOptions: SyncLoopOptions) => resolvedSyncLoop,
    deviceId,
    loginPrompter: resolvedLoginPrompter,
    now: () => now,
    tokenStore: createInMemoryTokenStore({ accessToken: 'access-token-1' }),
    ...rest,
  };
}

function fakeAuthClient(
  behavior: { workspaceId: string } | { throws: unknown } | { returnsNull: true },
): Pick<AuthClient, 'getActiveSession'> {
  return {
    async getActiveSession(): Promise<AuthActiveSession | null> {
      if ('throws' in behavior) {
        throw behavior.throws;
      }

      if ('returnsNull' in behavior) {
        return null;
      }

      return { workspaceId: behavior.workspaceId };
    },
  };
}

function notImplementedServerApi(): SyncServerApi {
  const notImplemented = () => {
    throw new Error('server API should not be called in this test');
  };

  return {
    cancelOcrJob: notImplemented,
    createOcrJob: notImplemented,
    createTemporaryUpload: notImplemented,
    getAxAllowlist: notImplemented,
    getCapabilities: notImplemented,
    getCapturePolicies: notImplemented,
    getCapture: notImplemented,
    ingestCapture: notImplemented,
    pollOcrJob: notImplemented,
    putTemporaryBytes: notImplemented,
    querySearch: notImplemented,
    queryTimeline: notImplemented,
    runOcrProxy: notImplemented,
    submitOcrResult: notImplemented,
  } as unknown as SyncServerApi;
}

class FakeLoginPrompter implements LoginPrompter {
  promptCalls = 0;
  result: LoginPromptResult = { workspaceId };

  async promptLogin(): Promise<LoginPromptResult> {
    this.promptCalls += 1;
    return this.result;
  }
}

class FakeSyncLoop implements SyncLoop {
  startCalls = 0;
  stopCalls = 0;

  start(): void {
    this.startCalls += 1;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }
}

function testStore(): OperationalStoreLifecycle & { initializeCalls: number; closeCalls: number } {
  const store = createInMemoryOperationalStore() as OperationalStoreRepository & {
    initializeCalls: number;
    closeCalls: number;
    initialize(): Promise<void>;
    close(): void;
  };

  store.initializeCalls = 0;
  store.closeCalls = 0;
  store.initialize = async () => {
    store.initializeCalls += 1;
  };
  store.close = () => {
    store.closeCalls += 1;
  };

  return store;
}

class FakeQuitEvent implements ElectronQuitEvent {
  preventedDefault = false;

  preventDefault(): void {
    this.preventedDefault = true;
  }
}

class FakeElectronApp implements ElectronAppLike {
  dock?: { hide(): void } | null;
  dockHideCalls = 0;
  quitCalls = 0;
  exitCalls: Array<number | undefined> = [];
  private readonly windowAllClosedListeners: Array<() => void> = [];
  private readonly beforeQuitListeners: Array<(event: ElectronQuitEvent) => void> = [];
  private resolveReady: (() => void) | undefined;
  private readonly readyPromise: Promise<void>;

  constructor(options: { withDock?: boolean } = {}) {
    this.dock =
      options.withDock === false
        ? undefined
        : {
            hide: () => {
              this.dockHideCalls += 1;
            },
          };
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }

  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  triggerReady(): void {
    this.resolveReady?.();
  }

  on(event: 'window-all-closed', listener: () => void): unknown;
  on(event: 'before-quit', listener: (event: ElectronQuitEvent) => void): unknown;
  on(
    event: 'window-all-closed' | 'before-quit',
    listener: (() => void) | ((event: ElectronQuitEvent) => void),
  ): unknown {
    if (event === 'window-all-closed') {
      this.windowAllClosedListeners.push(listener as () => void);
    } else {
      this.beforeQuitListeners.push(listener as (event: ElectronQuitEvent) => void);
    }
    return this;
  }

  quit(): void {
    this.quitCalls += 1;
  }

  exit(code?: number): void {
    this.exitCalls.push(code);
  }

  emitWindowAllClosed(): void {
    for (const listener of this.windowAllClosedListeners) {
      listener();
    }
  }

  emitBeforeQuit(event: ElectronQuitEvent): void {
    for (const listener of this.beforeQuitListeners) {
      listener(event);
    }
  }
}

class FakeIpcMain implements ElectronIpcMainLike {
  readonly handlers = new Map<
    string,
    (event: unknown, payload: unknown) => Promise<unknown> | unknown
  >();

  handle(
    channel: string,
    listener: (event: unknown, payload: unknown) => Promise<unknown> | unknown,
  ): unknown {
    this.handlers.set(channel, listener);
    return this;
  }

  async invoke(channel: string, payload: unknown): Promise<unknown> {
    const handler = this.handlers.get(channel);

    if (!handler) {
      throw new Error(`no handler registered for channel: ${channel}`);
    }

    return handler(undefined, payload);
  }
}

/**
 * Stands in for `createSpawnCaptureHelperClient(...)` in these tests: same
 * `CaptureHelperClient & CaptureHelperCommandClient` shape, but with no real
 * subprocess. Real cross-process spawning is covered by
 * `integration/capture-helper-process.test.ts` and the manual smoke test.
 */
class FakeHelperClient implements CaptureHelperClient, CaptureHelperCommandClient {
  startCalls = 0;
  stopCalls = 0;
  pauseCalls = 0;
  resumeCalls = 0;
  beginCaptureReasons: Array<'runtime_started' | 'user_resumed'> = [];
  sentCommands: Array<HelperEnvelope<MainToHelperType>> = [];
  stopImpl: () => Promise<void> = () => Promise.resolve();
  private onEnvelope: ((envelope: HelperEnvelope<HelperToMainType>) => Promise<void>) | undefined;

  async start(options: CaptureHelperStartOptions = {}): Promise<void> {
    this.startCalls += 1;
    this.onEnvelope = options.onEnvelope;
  }

  async beginCapture(reason: 'runtime_started' | 'user_resumed'): Promise<void> {
    this.beginCaptureReasons.push(reason);
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    return this.stopImpl();
  }

  async pauseCapture(): Promise<void> {
    this.pauseCalls += 1;
  }

  async resumeCapture(): Promise<void> {
    this.resumeCalls += 1;
  }

  async sendCommand(command: HelperEnvelope<MainToHelperType>): Promise<void> {
    this.sentCommands.push(command);
  }

  async emit(envelope: HelperEnvelope<HelperToMainType>): Promise<void> {
    await this.onEnvelope?.(envelope);
  }
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
