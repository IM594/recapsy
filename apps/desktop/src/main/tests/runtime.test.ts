import { describe, expect, it } from 'bun:test';
import type {
  AuthActiveSession,
  AuthClient,
  LoginPromptResult,
  LoginPrompter,
} from '../../auth/index';
import { createInMemoryTokenStore } from '../../auth/index';
import type {
  CaptureHelperClient,
  CaptureHelperCommandClient,
  CaptureHelperTransportEvent,
  CaptureHelperTransportObserver,
  HelperCapturePolicy,
  HelperEnvelope,
  HelperToMainType,
  MainToHelperType,
} from '../../helper/index';
import type { CapturePoliciesResult, ServerApiClient } from '../../server/index';
import type { DesktopShell } from '../../shell/index';
import { createMemoryStore } from '../../storage';
import type { SyncLoop, SyncLoopOptions, SyncRunResult, SyncServerApi } from '../../sync/index';
import {
  type DesktopShellFactoryContext,
  type DesktopStore,
  type ElectronAppLike,
  type ElectronIpcMainLike,
  type ElectronMainRuntimeOptions,
  type ElectronQuitEvent,
  createElectronMainRuntime,
} from '../runtime';

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

  it('capture.getStatus reflects helper state and permissions observed through the real handler', async () => {
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

    await helperClient.emit({
      correlationId: null,
      messageId: 'perm_granted_for_pause',
      payload: { accessibility: 'granted', observedAt: now, screenCapture: 'granted' },
      protocolVersion: 'recapsy.capture-helper',
      sentAt: now,
      type: 'permission.status',
    });
    helperClient.pauseCalls = 0;
    helperClient.resumeCalls = 0;

    const pauseResponse = await ipcMain.invoke('capture.pause', undefined);
    const resumeResponse = await ipcMain.invoke('capture.resume', undefined);

    expect(helperClient.pauseCalls).toBe(1);
    expect(helperClient.resumeCalls).toBe(1);
    expect(pauseResponse).toMatchObject({ data: { paused: true, state: 'paused' }, ok: true });
    expect(resumeResponse).toMatchObject({ data: { paused: false, state: 'capturing' }, ok: true });
  });

  it('permissions IPC reads helper status, refreshes, and opens privacy settings', async () => {
    const opened: string[] = [];
    const { app, ipcMain, helperClient, store } = harness();
    const handle = createElectronMainRuntime(
      baseOptions({
        app,
        helperClient,
        ipcMain,
        openExternalUrl: async (url) => {
          opened.push(url);
        },
        store,
      }),
    );
    app.triggerReady();
    await handle.ready;

    await helperClient.emit({
      correlationId: null,
      messageId: 'perm_status_1',
      payload: {
        accessibility: 'not_determined',
        observedAt: now,
        screenCapture: 'denied',
      },
      protocolVersion: 'recapsy.capture-helper',
      sentAt: now,
      type: 'permission.status',
    });

    const statusResponse = await ipcMain.invoke('permissions.getStatus', undefined);
    expect(statusResponse).toMatchObject({
      data: {
        accessibility: 'not_determined',
        accessibilityRequired: true,
        screenRecording: 'denied',
        screenRecordingRequired: true,
      },
      ok: true,
    });

    helperClient.refreshPermissionsImpl = async () => {
      await helperClient.emit({
        correlationId: null,
        messageId: 'perm_status_2',
        payload: {
          accessibility: 'granted',
          observedAt: '2026-07-08T00:00:01.000Z',
          screenCapture: 'granted',
        },
        protocolVersion: 'recapsy.capture-helper',
        sentAt: '2026-07-08T00:00:01.000Z',
        type: 'permission.status',
      });
      return { accessibility: 'granted', screenRecording: 'granted' };
    };
    helperClient.requestScreenRecordingPermissionImpl = async () => {
      return { accessibility: 'granted', screenRecording: 'granted' };
    };

    const refreshResponse = await ipcMain.invoke('permissions.refresh', undefined);
    expect(refreshResponse).toMatchObject({
      data: {
        accessibility: 'granted',
        screenRecording: 'granted',
        screenRecordingRequired: false,
      },
      ok: true,
    });

    const requestResponse = await ipcMain.invoke('permissions.requestScreenRecording', undefined);
    expect(requestResponse).toMatchObject({
      data: {
        screenRecording: 'granted',
        screenRecordingRequired: false,
      },
      ok: true,
    });
    expect(helperClient.sentCommands).toEqual([]);

    await expect(
      ipcMain.invoke('permissions.openScreenRecordingSettings', undefined),
    ).resolves.toMatchObject({ data: { opened: true }, ok: true });
    await expect(
      ipcMain.invoke('permissions.openAccessibilitySettings', undefined),
    ).resolves.toMatchObject({ data: { opened: true }, ok: true });
    expect(opened).toEqual([
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    ]);
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
        context: {
          app: { bundleId: 'com.apple.Safari', name: 'Safari' },
          observedAt: now,
          policy: { decision: 'allow', version: 'v1' },
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

    // The controller/handler must have acked the capture back to the helper
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
    let shellContext: DesktopShellFactoryContext | undefined;

    try {
      const handle = createElectronMainRuntime(
        baseOptions({
          app,
          authClient: fakeAuthClient({ throws: new Error('offline') }),
          createShell(context) {
            shellContext = context;
            return new FakeDesktopShell();
          },
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
      expect(shellContext?.workspaceIdVerified).toBe(false);
      expect(warnCalls.length).toBeGreaterThan(0);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('starts the policy-bounded sync worker pool and stops every worker as part of graceful quit', async () => {
    const { app, ipcMain, helperClient, store, syncLoop } = harness();
    const handle = createElectronMainRuntime(
      baseOptions({ app, helperClient, ipcMain, store, syncLoop }),
    );
    app.triggerReady();
    await handle.ready;

    expect(syncLoop.startCalls).toBe(2);
    expect(syncLoop.stopCalls).toBe(0);

    app.emitBeforeQuit(new FakeQuitEvent());
    await flushMicrotasks();

    expect(syncLoop.stopCalls).toBe(2);
  });

  it('keeps the tray shell available when the capture helper fails during startup', async () => {
    const { app, helperClient, ipcMain, store, syncLoop } = harness();
    helperClient.startImpl = async () => {
      throw new Error('helper startup failed');
    };
    const shell = new FakeDesktopShell();
    const handle = createElectronMainRuntime(
      baseOptions({
        app,
        createShell: () => shell,
        helperClient,
        ipcMain,
        store,
        syncLoop,
      }),
    );

    app.triggerReady();
    const state = await handle.ready;

    expect(state.control.getSnapshot()).toMatchObject({
      captureHelper: { lastSafeError: { code: 'helper_start_failed' }, state: 'failed' },
      status: 'stopped',
    });
    expect(syncLoop.startCalls).toBe(1);
    expect(shell.refreshCalls).toBe(1);
  });

  it('assembles the desktop shell, exposes its main-window IPC action, and disposes it during quit', async () => {
    const { app, ipcMain, helperClient, store } = harness();
    const syncLoop = new FakeSyncLoop();
    const shell = new FakeDesktopShell();
    let shellContext: DesktopShellFactoryContext | undefined;
    const handle = createElectronMainRuntime(
      baseOptions({
        app,
        createShell(context) {
          shellContext = context;
          return shell;
        },
        helperClient,
        ipcMain,
        store,
        syncLoop,
      }),
    );
    app.triggerReady();
    const state = await handle.ready;

    expect(shellContext).toMatchObject({
      control: state.control,
      store,
      workspaceId,
      workspaceIdVerified: true,
    });
    expect(shellContext?.commandClient).toBe(state.commandClient);
    expect(state.shell).toBe(shell);
    await expect(ipcMain.invoke('app.showMainWindow', undefined)).resolves.toEqual({
      data: { shown: true },
      ok: true,
    });
    expect(shell.showMainWindowCalls).toBe(1);

    app.emitBeforeQuit(new FakeQuitEvent());
    await flushMicrotasks();
    expect(shell.disposeCalls).toBe(1);
    expect(helperClient.stopCalls).toBe(1);
    expect(syncLoop.stopCalls).toBe(2);
  });

  it('routes native asset write failures into storage admission without dropping accepted work', async () => {
    const { app, ipcMain, helperClient, store } = harness();
    let shellContext: DesktopShellFactoryContext | undefined;
    const handle = createElectronMainRuntime(
      baseOptions({
        app,
        createShell(context) {
          shellContext = context;
          return new FakeDesktopShell();
        },
        helperClient,
        ipcMain,
        storageAdmission: {
          minAvailableBytes: 100,
          probe: async () => ({ availableBytes: 200, writable: true }),
          resumeAvailableBytes: 200,
          verifyWrite: async () => undefined,
        },
        store,
      }),
    );
    app.triggerReady();
    await handle.ready;
    await store.createCaptureOutboxEntry({
      assetRefId: 'asset_accepted',
      assetRefs: [
        {
          assetRefId: 'asset_accepted',
          availabilityState: 'available',
          cleanupState: 'retained',
          createdAt: now,
          hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          localAccessKey: 'capture_accepted/screenshot.webp',
          mimeType: 'image/webp',
          role: 'capture_original',
          sizeBytes: 1024,
          workspaceId,
        },
      ],
      createdAt: now,
      deviceId,
      id: 'job_accepted',
      idempotencyKey: 'accepted-before-write-failure',
      payloadHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      workspaceId,
    });

    await helperClient.emit({
      correlationId: null,
      messageId: 'capture_error_1',
      payload: {
        captureId: 'capture_1',
        code: 'asset_write_failed',
        message: 'disk full at a private local path',
      },
      protocolVersion: 'recapsy.capture-helper',
      sentAt: now,
      type: 'capture.error',
    });

    expect(shellContext?.control.getSnapshot().admission).toEqual({
      reasons: ['asset_write_failed'],
    });
    expect(shellContext?.control.getSnapshot().pauseReasons).toContain('storage');
    expect(await store.listOutboxJobs({ workspaceId })).toMatchObject([
      { id: 'job_accepted', state: 'pending' },
    ]);
  });

  it('continues runtime shutdown when synchronous shell disposal fails', async () => {
    const { app, ipcMain, helperClient, store } = harness();
    const syncLoop = new FakeSyncLoop();
    const failingShell = new FakeDesktopShell({ disposeThrows: true });
    const handle = createElectronMainRuntime(
      baseOptions({
        app,
        createShell: () => failingShell,
        helperClient,
        ipcMain,
        store,
        syncLoop,
      }),
    );
    app.triggerReady();
    await handle.ready;

    app.emitBeforeQuit(new FakeQuitEvent());
    await flushMicrotasks();

    expect(failingShell.disposeCalls).toBe(1);
    expect(helperClient.stopCalls).toBe(1);
    expect(syncLoop.stopCalls).toBe(2);
    expect(app.exitCalls).toEqual([0]);
  });

  it('invokes onHelperEnvelope with the same envelope before it reaches the real handler', async () => {
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

    // The wrapper must still delegate to the real (well-tested) handler —
    // this envelope should be reflected in capture.getStatus exactly as it
    // would be without onHelperEnvelope wired up.
    const response = await ipcMain.invoke('capture.getStatus', undefined);
    expect(response).toMatchObject({
      data: { permissions: { accessibility: 'granted', screenRecording: 'granted' } },
      ok: true,
    });
  });

  it('does not wrap the event handler when onHelperEnvelope is not supplied', async () => {
    const { app, ipcMain, helperClient, store } = harness();
    const handle = createElectronMainRuntime(baseOptions({ app, helperClient, ipcMain, store }));
    app.triggerReady();
    await handle.ready;

    // No onHelperEnvelope wired up; a real envelope must still flow through
    // to the handler exactly as today (no behavior change when the dev flag
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
    const observedResults: SyncRunResult[] = [];
    const onSyncResult = (result: SyncRunResult): void => {
      observedResults.push(result);
    };
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

    capturedOptions?.onResult?.({ processed: 0, status: 'idle' });
    expect(observedResults).toEqual([{ processed: 0, status: 'idle' }]);
    expect(capturedOptions?.onError).toBe(onSyncError);
  });
});

type Harness = {
  app: FakeElectronApp;
  ipcMain: FakeIpcMain;
  helperClient: FakeHelperClient;
  store: DesktopStore & { initializeCalls: number; closeCalls: number };
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
    store: DesktopStore;
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

function notImplementedServerApi(): SyncServerApi & Pick<ServerApiClient, 'getCapturePolicies'> {
  const notImplemented = () => {
    throw new Error('server API should not be called in this test');
  };

  return {
    getAxAllowlist: notImplemented,
    getCapabilities: notImplemented,
    async getCapturePolicies(input: {
      workspaceId: string;
      deviceId?: string;
    }): Promise<CapturePoliciesResult> {
      return {
        axAllowlist: {
          axTextUploadEnabled: false,
          enabled: false,
          reason: 'ax_text_upload_disabled',
          status: 'disabled',
          workspaceId: input.workspaceId,
        },
        capturePolicy: {
          actionCounts: {},
          axTextUploadEnabled: false,
          defaultAction: 'allow',
          expiresAt: '2026-07-08T01:00:00.000Z',
          id: 'snapshot_runtime',
          paused: false,
          policy: {
            axTextUploadEnabled: false,
            defaultAction: 'allow',
            paused: false,
            rules: [],
          },
          rules: [],
          ttlSeconds: 3600,
          version: 'policy_runtime',
        },
        deliveryPolicy: { maxConcurrentOcr: 2 },
        deviceId: input.deviceId ?? null,
        generatedAt: now,
        storagePolicy: {
          allowLongTermRemoteOriginal: false,
          authoritativeOriginalLocation: 'local_device',
        },
        workspaceId: input.workspaceId,
      };
    },
    getCapture: notImplemented,
    createCapture: notImplemented,
    querySearch: notImplemented,
    queryTimeline: notImplemented,
    runOcrProxy: notImplemented,
    submitOcrResult: notImplemented,
  } as unknown as SyncServerApi & Pick<ServerApiClient, 'getCapturePolicies'>;
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

class FakeDesktopShell implements DesktopShell {
  disposeCalls = 0;
  refreshCalls = 0;
  showMainWindowCalls = 0;

  constructor(private readonly options: { disposeThrows?: boolean } = {}) {}

  dispose(): void {
    this.disposeCalls += 1;
    if (this.options.disposeThrows) {
      throw new Error('shell dispose failure');
    }
  }

  async showMainWindow(): Promise<{ shown: true }> {
    this.showMainWindowCalls += 1;
    return { shown: true };
  }

  async refresh() {
    this.refreshCalls += 1;
    return {
      accessibility: 'granted',
      capturePaused: false,
      captureState: 'running',
      screenRecording: 'granted',
      syncBlocked: 0,
      syncFailed: 0,
      syncPending: 0,
      syncRetrying: 0,
    };
  }
}

function testStore(): DesktopStore & { initializeCalls: number; closeCalls: number } {
  const store = Object.assign(createMemoryStore(), {
    closeCalls: 0,
    initializeCalls: 0,
    close() {
      this.closeCalls += 1;
    },
    async initialize() {
      this.initializeCalls += 1;
    },
  });

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
 * Stands in for `createHelperProcessClient(...)` in these tests: same
 * `CaptureHelperClient & CaptureHelperCommandClient` shape, but with no real
 * subprocess. Real cross-process spawning is covered by
 * `tests/integration/capture-process.test.ts` and the manual smoke test.
 */
class FakeHelperClient implements CaptureHelperClient, CaptureHelperCommandClient {
  startCalls = 0;
  stopCalls = 0;
  pauseCalls = 0;
  resumeCalls = 0;
  beginCaptureReasons: Array<'runtime_started' | 'user_resumed'> = [];
  sentCommands: Array<HelperEnvelope<MainToHelperType>> = [];
  startImpl: () => Promise<void> = () => Promise.resolve();
  stopImpl: () => Promise<void> = () => Promise.resolve();
  refreshPermissionsImpl: () => Promise<{
    accessibility: 'granted' | 'denied' | 'not_determined' | 'unknown';
    screenRecording: 'granted' | 'denied' | 'not_determined' | 'unknown';
  }> = async () => ({ accessibility: 'unknown', screenRecording: 'unknown' });
  requestScreenRecordingPermissionImpl: () => Promise<{
    accessibility: 'granted' | 'denied' | 'not_determined' | 'unknown';
    screenRecording: 'granted' | 'denied' | 'not_determined' | 'unknown';
  }> = async () => ({ accessibility: 'unknown', screenRecording: 'unknown' });
  onSendCommand: ((command: HelperEnvelope<MainToHelperType>) => Promise<void>) | undefined;
  private observer: CaptureHelperTransportObserver | undefined;

  async start(observer: CaptureHelperTransportObserver): Promise<void> {
    this.startCalls += 1;
    this.observer = observer;
    await this.startImpl();
  }

  async beginCapture(reason: 'runtime_started' | 'user_resumed'): Promise<void> {
    this.beginCaptureReasons.push(reason);
  }

  async configureCapture(_policy: HelperCapturePolicy): Promise<void> {}

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
    await this.onSendCommand?.(command);
  }

  async refreshPermissions() {
    return await this.refreshPermissionsImpl();
  }

  async requestScreenRecordingPermission() {
    return await this.requestScreenRecordingPermissionImpl();
  }

  async emit(envelope: HelperEnvelope<HelperToMainType>): Promise<void> {
    await this.observer?.handle({ envelope, type: 'envelope' });
  }

  async emitTransportEvent(event: CaptureHelperTransportEvent): Promise<void> {
    await this.observer?.handle(event);
  }
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
