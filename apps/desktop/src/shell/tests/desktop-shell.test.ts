import { describe, expect, it } from 'bun:test';
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
      screenRecording: 'not_determined',
      syncBlocked: 0,
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
        async resumeCapture() {},
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
    expect(tooltip).toContain('Screen recording required');
    expect(
      menuBuilds.at(-1)?.some((item) => item.kind === 'action' && item.label === 'Open Recapsy'),
    ).toBe(true);

    await expect(shell.showMainWindow()).resolves.toEqual({ shown: true });
    expect(loadedPath).toBe('/tmp/main-window.html');
    expect(sent).toContainEqual(status);

    shell.dispose();
    expect(destroyed).toBe(true);
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
    findAction(harness.menuBuilds.at(-1), 'Screen Recording: Denied').click?.();
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
    expect(harness.tooltipUpdates[0]).toContain('2 sync pending');

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
    findAction(readyHarness.menuBuilds.at(-1), 'Pause Capture').click?.();
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
    findAction(harness.menuBuilds.at(-1), 'Refresh Permissions').click?.();
    await flushMicrotasks();

    expect(safeErrors).toEqual(['Desktop shell operation failed.']);
    expect(safeErrors.join(' ')).not.toContain('permission_refresh_timeout');

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
  ])('gates capture menu actions for $name', async ({ value, pauseEnabled, resumeEnabled }) => {
    const harness = createShellHarness({ status: value });
    await harness.shell.refresh();

    const menu = harness.menuBuilds.at(-1);
    expect(findAction(menu, 'Pause Capture').enabled).toBe(pauseEnabled);
    expect(findAction(menu, 'Resume Capture').enabled).toBe(resumeEnabled);

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
      pauseCapture(): Promise<void>;
      resumeCapture(): Promise<void>;
      refreshPermissions(): Promise<void>;
      openScreenRecordingSettings(): Promise<void>;
      openAccessibilitySettings(): Promise<void>;
    }>;
    onSafeError?(message: string): void;
    status?: DesktopShellStatus;
    statusSource?: { getStatus(): Promise<DesktopShellStatus> };
  } = {},
) {
  const menuBuilds: DesktopShellMenuItem[][] = [];
  const sent: unknown[] = [];
  const tooltipUpdates: string[] = [];
  let trayDestroyed = false;
  let refreshPermissionCalls = 0;
  const window = new FakeWindow(sent);

  const tray: DesktopShellTray = {
    destroy() {
      trayDestroyed = true;
    },
    on() {},
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
  };

  const shell = createDesktopShell({
    actions: {
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
      async resumeCapture() {
        await options.actions?.resumeCapture?.();
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
    get refreshPermissionCalls() {
      return refreshPermissionCalls;
    },
    sent,
    shell,
    tooltipUpdates,
    get trayDestroyed() {
      return trayDestroyed;
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
    screenRecording: 'granted',
    syncBlocked: 0,
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
