import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermissionRefreshError } from '../../permissions';
import {
  type DesktopShellAdapters,
  type DesktopShellMenuItem,
  type DesktopShellTray,
  type DesktopShellWindow,
  createDesktopShell,
} from '../desktop-shell';
import type { DesktopShellStatus } from '../status-model';

describe('desktop shell', () => {
  it('keeps device-local privacy controls visible in the main window source', async () => {
    const source = await readFile(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'main-window.html'),
      'utf8',
    );

    expect(source).toContain('本地隐私');
    expect(source.replace(/\s+/g, ' ')).toContain(
      '被屏蔽应用或网站的后续采集不会保存资源，也不会进入同步队列或 OCR 管线。',
    );
    expect(source).toContain('id="privacy-bundle-id"');
    expect(source).toContain('captureBlockBundle');
    expect(source).toContain('屏蔽当前网站');
    expect(source).toContain('屏蔽整个网站');
    expect(source).toContain('captureRemoveLocalRule');
    expect(source).toContain('status.syncLastErrorCode');
    expect(source).toContain('status.syncLastErrorMessage');
    expect(source).toContain('id="sync-processing"');
    expect(source).toContain('id="sync-pending"');
    expect(source).toContain('id="sync-oldest"');
  });

  it('creates a tray, shows the main window, and pushes status updates', async () => {
    const menuBuilds: DesktopShellMenuItem[][] = [];
    const sent: unknown[] = [];
    let tooltip = '';
    let destroyed = false;
    let loadedPath: string | undefined;

    const window: DesktopShellWindow = {
      focus() {},
      isDestroyed: () => false,
      isVisible: () => true,
      async loadFile(path) {
        loadedPath = path;
      },
      on() {},
      once() {},
      show() {},
      webContents: {
        send(_channel, payload) {
          sent.push(payload);
        },
      },
    };

    const tray: DesktopShellTray = {
      destroy() {
        destroyed = true;
      },
      on() {},
      setContextMenu() {},
      setToolTip(value) {
        tooltip = value;
      },
    };

    const adapters: DesktopShellAdapters = {
      buildMenu(items) {
        menuBuilds.push(items);
        return {};
      },
      createTray: () => tray,
      createWindow: () => window,
      quit() {},
    };

    const status: DesktopShellStatus = {
      accessibility: 'not_determined',
      capturePaused: false,
      captureState: 'running',
      lastHeartbeatAt: new Date().toISOString(),
      screenRecording: 'not_determined',
      syncBlocked: 0,
      syncGate: { state: 'open' },
      syncFailed: 0,
      syncPending: 1,
      syncRetrying: 0,
    };

    const shell = createDesktopShell({
      actions: {
        async openAccessibilitySettings() {},
        async openScreenRecordingSettings() {},
        async pauseCapture() {},
        async refreshPermissions() {},
        async requeueTerminalJobs() {
          return 0;
        },
        async resumeCapture() {},
        async resumeProviderSync() {},
      },
      adapters,
      mainWindowHtmlPath: '/tmp/main-window.html',
      refreshIntervalMs: 60_000,
      statusSource: {
        async getStatus() {
          return status;
        },
      },
    });

    await shell.refresh();
    expect(tooltip).toContain('需要屏幕录制权限');
    expect(
      menuBuilds
        .at(-1)
        ?.some((item) => item.kind === 'action' && item.label === '打开 Recapsy Preview'),
    ).toBe(true);

    await expect(shell.showMainWindow()).resolves.toEqual({ shown: true });
    expect(loadedPath).toBe('/tmp/main-window.html');
    expect(sent).toContainEqual(status);

    shell.dispose();
    expect(destroyed).toBe(true);
  });

  it('opens the tray menu instead of the main window when the tray is clicked', async () => {
    const harness = createShellHarness();
    await harness.shell.refresh();

    harness.emitTrayClick();
    await flushMicrotasks();

    expect(harness.popUpContextMenuCalls).toBe(1);
    expect(harness.window.events).not.toContain('load');
    expect(harness.window.events).not.toContain('show');
    harness.shell.dispose();
  });

  it('offers plain-language app, website, and website-family privacy actions for the latest source', async () => {
    const blocked: unknown[] = [];
    const confirmations: string[] = [];
    const harness = createShellHarness({
      actions: {
        async addLocalRule(input) {
          blocked.push(input);
        },
      },
      adapters: {
        async confirm(message) {
          confirmations.push(message);
          return true;
        },
      },
      status: {
        ...status(),
        source: {
          applicationName: 'Safari',
          bundleId: 'com.apple.Safari',
          domain: 'github.com',
          observedAt: new Date().toISOString(),
        },
      },
    });

    await harness.shell.refresh();
    const menu = harness.menuBuilds.at(-1);
    const app = findAction(menu, '屏蔽当前应用 · Safari');
    const exact = findAction(menu, '屏蔽当前网站 · github.com');
    const family = findAction(menu, '屏蔽整个网站 · github.com 及其子网站');
    app.click?.();
    exact.click?.();
    family.click?.();
    await flushMicrotasks();

    expect(blocked).toEqual([
      { kind: 'bundle_id', pattern: 'com.apple.Safari' },
      { kind: 'domain', pattern: 'github.com' },
      { kind: 'domain_family', pattern: 'github.com' },
    ]);
    expect(confirmations[0]).toContain('github.com');
    expect(confirmations[0]).toContain('www.github.com');
  });

  it('refreshes the tray immediately when the status source announces a change', async () => {
    let current = status();
    let notifySourceChanged: (() => void) | undefined;
    const harness = createShellHarness({
      statusSource: {
        async getStatus() {
          return current;
        },
        subscribe(listener) {
          notifySourceChanged = listener;
          return () => {
            notifySourceChanged = undefined;
          };
        },
      },
    });

    await harness.shell.refresh();
    const initialBuildCount = harness.menuBuilds.length;
    current = status({
      source: {
        applicationName: 'Safari',
        bundleId: 'com.apple.Safari',
        domain: 'github.com',
        observedAt: new Date().toISOString(),
      },
    });
    notifySourceChanged?.();
    await flushMicrotasks();

    expect(harness.menuBuilds.length).toBeGreaterThan(initialBuildCount);
    expect(findAction(harness.menuBuilds.at(-1), '屏蔽当前网站 · github.com')).toBeDefined();
    harness.shell.dispose();
  });

  it('waits for the main window to regain focus before refreshing permissions after opening Screen Recording settings', async () => {
    const actions: string[] = [];
    const harness = createShellHarness({
      actions: {
        async openScreenRecordingSettings() {
          actions.push('open-settings');
          harness.window.emitFocus();
        },
      },
      status: status({ screenRecording: 'denied' }),
    });

    await harness.shell.refresh();
    findAction(harness.menuBuilds.at(-1), '屏幕录制：已拒绝').click?.();
    await flushMicrotasks();

    expect(actions).toEqual(['open-settings']);
    expect(harness.refreshPermissionCalls).toBe(0);
    expect(harness.window.events).toEqual(['load', 'show', 'focus']);

    harness.window.emitFocus();
    await flushMicrotasks();
    expect(harness.refreshPermissionCalls).toBe(1);

    harness.window.emitFocus();
    await flushMicrotasks();
    expect(harness.refreshPermissionCalls).toBe(1);

    harness.shell.dispose();
  });

  it('uses a single in-flight status read so a slower refresh cannot overwrite a newer tray state', async () => {
    const firstStatus = deferred<DesktopShellStatus>();
    let statusReads = 0;
    const harness = createShellHarness({
      statusSource: {
        getStatus() {
          statusReads += 1;
          return firstStatus.promise;
        },
      },
    });

    const firstRefresh = harness.shell.refresh();
    const secondRefresh = harness.shell.refresh();

    await flushMicrotasks();
    expect(statusReads).toBe(1);
    expect(firstRefresh).toBe(secondRefresh);

    firstStatus.resolve(status({ syncPending: 2 }));
    await expect(firstRefresh).resolves.toEqual(status({ syncPending: 2 }));
    expect(harness.tooltipUpdates).toHaveLength(1);
    expect(harness.tooltipUpdates[0]).toContain('排队 2');

    harness.shell.dispose();
  });

  it('does not update the tray or main window when an in-flight status read settles after dispose', async () => {
    const pendingStatus = deferred<DesktopShellStatus>();
    const harness = createShellHarness({
      statusSource: { getStatus: () => pendingStatus.promise },
    });

    harness.shell.dispose();
    pendingStatus.resolve(status());
    await flushMicrotasks();

    expect(harness.trayDestroyed).toBe(true);
    expect(harness.tooltipUpdates).toEqual([]);
    expect(harness.menuBuilds).toEqual([]);
    expect(harness.sent).toEqual([]);
  });

  it('contains status and menu-action failures behind a fixed safe error message', async () => {
    const safeErrors: string[] = [];
    const harness = createShellHarness({
      actions: {
        async pauseCapture() {
          throw new Error('/Users/example/private-capture.webp');
        },
      },
      onSafeError(message) {
        safeErrors.push(message);
      },
      statusSource: {
        async getStatus() {
          throw new Error('/private/var/folders/secret-status');
        },
      },
    });

    await flushMicrotasks();
    expect(safeErrors).toEqual(['Desktop shell operation failed.']);

    const readyHarness = createShellHarness({
      actions: {
        async pauseCapture() {
          throw new Error('/Users/example/private-capture.webp');
        },
      },
      onSafeError(message) {
        safeErrors.push(message);
      },
    });
    await readyHarness.shell.refresh();
    findAction(readyHarness.menuBuilds.at(-1), '暂停采集').click?.();
    await flushMicrotasks();

    expect(safeErrors).toEqual([
      'Desktop shell operation failed.',
      'Desktop shell operation failed.',
    ]);
    expect(safeErrors.join(' ')).not.toContain('/Users');
    expect(safeErrors.join(' ')).not.toContain('/private');

    harness.shell.dispose();
    readyHarness.shell.dispose();
  });

  it('contains a direct permission refresh timeout behind the shell safe-error boundary', async () => {
    const safeErrors: string[] = [];
    const harness = createShellHarness({
      actions: {
        async refreshPermissions() {
          throw new PermissionRefreshError('permission_refresh_timeout');
        },
      },
      onSafeError(message) {
        safeErrors.push(message);
      },
    });

    await harness.shell.refresh();
    findAction(harness.menuBuilds.at(-1), '刷新权限').click?.();
    await flushMicrotasks();

    expect(safeErrors).toEqual(['Desktop shell operation failed.']);
    expect(safeErrors.join(' ')).not.toContain('permission_refresh_timeout');

    harness.shell.dispose();
  });

  it('notifies once for an active health issue and makes the menu-bar status actionable', async () => {
    let current = status();
    const harness = createShellHarness({
      statusSource: {
        async getStatus() {
          return current;
        },
      },
    });

    await harness.shell.refresh();
    current = status({ lastErrorCode: 'helper_unexpected_exit' });
    await harness.shell.refresh();
    await harness.shell.refresh();

    expect(harness.notifications).toEqual([
      {
        body: '采集意外停止。请打开 Recapsy Preview 恢复采集。',
        title: 'Recapsy Preview 采集已停止',
      },
    ]);
    expect(harness.tooltipUpdates.at(-1)).toContain('采集已停止');
    expect(
      harness.menuBuilds
        .at(-1)
        ?.some((item) => item.kind === 'action' && item.label === '注意：采集已停止'),
    ).toBe(true);

    harness.shell.dispose();
  });

  it('exposes provider-sync resume and terminal recovery as explicit tray actions', async () => {
    const actions: string[] = [];
    const harness = createShellHarness({
      actions: {
        async requeueTerminalJobs() {
          actions.push('requeue');
          return 2;
        },
        async resumeProviderSync() {
          actions.push('resume');
        },
      },
      status: status({
        syncFailed: 2,
        syncGate: {
          nextProbeAt: '2026-07-27T00:01:00.000Z',
          pausedAt: '2026-07-27T00:00:00.000Z',
          reason: 'provider_auth_failed',
          state: 'paused',
        },
      }),
    });

    await harness.shell.refresh();
    const menu = harness.menuBuilds.at(-1);
    findAction(menu, '恢复同步').click?.();
    findAction(menu, '重新处理失败项').click?.();
    await flushMicrotasks();

    expect(actions).toEqual(['resume', 'requeue']);
    expect(harness.tooltipUpdates.at(-1)).toContain('同步已暂停');
    harness.shell.dispose();
  });

  it.each([
    {
      name: 'running capture without Screen Recording permission',
      value: status({ capturePaused: false, captureState: 'running', screenRecording: 'denied' }),
      pauseEnabled: true,
      resumeEnabled: false,
    },
    {
      name: 'paused capture without Screen Recording permission',
      value: status({ capturePaused: true, captureState: 'paused', screenRecording: 'denied' }),
      pauseEnabled: false,
      resumeEnabled: false,
    },
    {
      name: 'paused capture with Screen Recording permission',
      value: status({ capturePaused: true, captureState: 'paused', screenRecording: 'granted' }),
      pauseEnabled: false,
      resumeEnabled: true,
    },
    {
      name: 'automatic catch-up pause with Screen Recording permission',
      value: status({
        capturePaused: true,
        capturePauseReason: 'backpressure',
        captureState: 'paused',
        screenRecording: 'granted',
      }),
      pauseEnabled: false,
      resumeEnabled: false,
    },
  ])('gates capture menu actions for $name', async ({ value, pauseEnabled, resumeEnabled }) => {
    const harness = createShellHarness({ status: value });
    await harness.shell.refresh();

    const menu = harness.menuBuilds.at(-1);
    expect(findAction(menu, '暂停采集').enabled).toBe(pauseEnabled);
    expect(findAction(menu, '继续采集').enabled).toBe(resumeEnabled);

    harness.shell.dispose();
  });

  it('leaves permission-return refresh ownership with the main-process shell', async () => {
    const html = await Bun.file(new URL('../main-window.html', import.meta.url)).text();

    expect(html).not.toContain("window.addEventListener('focus'");
  });
});

function createShellHarness(
  options: {
    actions?: Partial<{
      addLocalRule(input: {
        kind: 'bundle_id' | 'domain' | 'domain_family';
        pattern: string;
      }): Promise<void>;
      pauseCapture(): Promise<void>;
      resumeCapture(): Promise<void>;
      refreshPermissions(): Promise<void>;
      requeueTerminalJobs(): Promise<number>;
      openScreenRecordingSettings(): Promise<void>;
      openAccessibilitySettings(): Promise<void>;
      resumeProviderSync(): Promise<void>;
    }>;
    adapters?: Partial<Pick<DesktopShellAdapters, 'confirm'>>;
    onSafeError?(message: string): void;
    status?: DesktopShellStatus;
    statusSource?: {
      getStatus(): Promise<DesktopShellStatus>;
      subscribe?(listener: () => void): () => void;
    };
  } = {},
) {
  const menuBuilds: DesktopShellMenuItem[][] = [];
  const notifications: Array<{ body: string; title: string }> = [];
  const sent: unknown[] = [];
  const tooltipUpdates: string[] = [];
  const trayListeners: Partial<Record<'click', () => void>> = {};
  let popUpContextMenuCalls = 0;
  let trayDestroyed = false;
  let refreshPermissionCalls = 0;
  const window = new FakeWindow(sent);

  const tray: DesktopShellTray = {
    destroy() {
      trayDestroyed = true;
    },
    on(event, listener) {
      if (event === 'click') trayListeners.click = listener;
    },
    popUpContextMenu() {
      popUpContextMenuCalls += 1;
    },
    setContextMenu() {},
    setToolTip(value) {
      tooltipUpdates.push(value);
    },
  };

  const adapters: DesktopShellAdapters = {
    buildMenu(items) {
      menuBuilds.push(items);
      return {};
    },
    createTray: () => tray,
    createWindow: () => window,
    quit() {},
    ...(options.adapters ?? {}),
    showNotification(notification) {
      notifications.push(notification);
    },
  };

  const shell = createDesktopShell({
    actions: {
      async addLocalRule(input) {
        await options.actions?.addLocalRule?.(input);
      },
      async openAccessibilitySettings() {
        await options.actions?.openAccessibilitySettings?.();
      },
      async openScreenRecordingSettings() {
        await options.actions?.openScreenRecordingSettings?.();
      },
      async pauseCapture() {
        await options.actions?.pauseCapture?.();
      },
      async refreshPermissions() {
        refreshPermissionCalls += 1;
        await options.actions?.refreshPermissions?.();
      },
      async requeueTerminalJobs() {
        return (await options.actions?.requeueTerminalJobs?.()) ?? 0;
      },
      async resumeCapture() {
        await options.actions?.resumeCapture?.();
      },
      async resumeProviderSync() {
        await options.actions?.resumeProviderSync?.();
      },
    },
    adapters,
    mainWindowHtmlPath: '/tmp/main-window.html',
    onSafeError: options.onSafeError,
    refreshIntervalMs: 60_000,
    statusSource: options.statusSource ?? {
      async getStatus() {
        return options.status ?? status();
      },
    },
  });

  return {
    menuBuilds,
    notifications,
    emitTrayClick() {
      trayListeners.click?.();
    },
    get refreshPermissionCalls() {
      return refreshPermissionCalls;
    },
    sent,
    shell,
    tooltipUpdates,
    get trayDestroyed() {
      return trayDestroyed;
    },
    get popUpContextMenuCalls() {
      return popUpContextMenuCalls;
    },
    window,
  };
}

class FakeWindow implements DesktopShellWindow {
  events: string[] = [];
  private focusListener: (() => void) | undefined;

  constructor(private readonly sent: unknown[]) {}

  focus(): void {
    this.events.push('focus');
  }

  isDestroyed(): boolean {
    return false;
  }

  isVisible(): boolean {
    return true;
  }

  async loadFile(_path: string): Promise<void> {
    this.events.push('load');
  }

  on(event: 'closed', listener: () => void): unknown {
    if (event === 'closed') {
      return listener;
    }
    return undefined;
  }

  once(_event: 'focus', listener: () => void): unknown {
    this.focusListener = listener;
    return listener;
  }

  show(): void {
    this.events.push('show');
  }

  emitFocus(): void {
    const listener = this.focusListener;
    this.focusListener = undefined;
    listener?.();
  }

  webContents = {
    send: (_channel: string, payload: unknown) => {
      this.sent.push(payload);
    },
  };
}

function status(overrides: Partial<DesktopShellStatus> = {}): DesktopShellStatus {
  return {
    accessibility: 'granted',
    capturePaused: false,
    captureState: 'running',
    lastHeartbeatAt: new Date().toISOString(),
    screenRecording: 'granted',
    syncBlocked: 0,
    syncGate: { state: 'open' },
    syncFailed: 0,
    syncPending: 0,
    syncRetrying: 0,
    ...overrides,
  };
}

function findAction(
  menu: DesktopShellMenuItem[] | undefined,
  label: string,
): Extract<DesktopShellMenuItem, { kind: 'action' }> {
  const item = menu?.find((entry) => entry.kind === 'action' && entry.label === label);
  if (!item || item.kind !== 'action') {
    throw new Error(`Missing ${label} menu action.`);
  }
  return item;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
