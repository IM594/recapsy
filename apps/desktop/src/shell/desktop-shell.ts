import productIdentity from '../product-identity.json';
import {
  type DesktopHealthAlert,
  type DesktopHealthMonitor,
  createDesktopHealthMonitor,
} from './health-monitor';
import type { DesktopShellStatus } from './status-model';
import {
  formatPermissionLabel,
  formatTrayTooltip,
  isCaptureBlockedByPermissions,
} from './status-model';

export type DesktopShellWindow = {
  isDestroyed(): boolean;
  isVisible(): boolean;
  show(): void;
  focus(): void;
  on(event: 'closed', listener: () => void): unknown;
  once(event: 'focus', listener: () => void): unknown;
  loadFile(path: string): Promise<void>;
  webContents: {
    send(channel: string, payload: unknown): void;
  };
};

export type DesktopShellTray = {
  setToolTip(tooltip: string): void;
  setContextMenu(menu: unknown): void;
  popUpContextMenu?(): void;
  on(event: 'click', listener: () => void): unknown;
  destroy(): void;
};

export type DesktopShellMenuItem =
  | { kind: 'separator' }
  | {
      kind: 'action';
      label: string;
      enabled?: boolean;
      click?(): void;
    };

export type DesktopShellMenu = unknown;

export type DesktopShellNotification = {
  title: string;
  body: string;
};

export type DesktopShellAdapters = {
  createWindow(): DesktopShellWindow;
  createTray(): DesktopShellTray;
  buildMenu(items: DesktopShellMenuItem[]): DesktopShellMenu;
  quit(): void;
  showNotification?(notification: DesktopShellNotification): void;
};

export type DesktopShellStatusSource = {
  getStatus(): Promise<DesktopShellStatus>;
};

export type DesktopShellActions = {
  pauseCapture(): Promise<void>;
  resumeCapture(): Promise<void>;
  openScreenRecordingSettings(): Promise<void>;
  openAccessibilitySettings(): Promise<void>;
  refreshPermissions(): Promise<void>;
  requeueTerminalJobs(): Promise<number>;
  resumeProviderSync(): Promise<void>;
};

export type DesktopShellOptions = {
  adapters: DesktopShellAdapters;
  statusSource: DesktopShellStatusSource;
  actions: DesktopShellActions;
  mainWindowHtmlPath: string;
  refreshIntervalMs?: number;
  now?(): number;
  healthMonitor?: DesktopHealthMonitor;
  onSafeError?(message: 'Desktop shell operation failed.'): void;
};

export type DesktopShell = {
  showMainWindow(): Promise<{ shown: true }>;
  refresh(): Promise<DesktopShellStatus>;
  dispose(): void;
};

const STATUS_PUSH_CHANNEL = 'shell.statusUpdated';
const DEFAULT_REFRESH_INTERVAL_MS = 3000;
const SAFE_SHELL_OPERATION_ERROR = 'Desktop shell operation failed.' as const;
const SHELL_UNAVAILABLE_ERROR = 'Desktop shell is unavailable.';

export function createDesktopShell(options: DesktopShellOptions): DesktopShell {
  return new DesktopShellController(options);
}

class DesktopShellController implements DesktopShell {
  private window: DesktopShellWindow | undefined;
  private readonly tray: DesktopShellTray;
  private disposed = false;
  private lastStatus: DesktopShellStatus | undefined;
  private readonly refreshInterval: ReturnType<typeof setInterval>;
  private refreshInFlight: Promise<DesktopShellStatus> | undefined;
  private permissionRefreshPending = false;
  private permissionRefreshToken = 0;
  private readonly healthMonitor: DesktopHealthMonitor;

  constructor(private readonly options: DesktopShellOptions) {
    this.healthMonitor = options.healthMonitor ?? createDesktopHealthMonitor();
    this.tray = options.adapters.createTray();
    this.tray.on('click', () => {
      this.tray.popUpContextMenu?.();
    });
    this.refreshInterval = setInterval(() => {
      this.runInBackground(() => this.refresh());
    }, options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS);
    this.runInBackground(() => this.refresh());
  }

  async showMainWindow(): Promise<{ shown: true }> {
    if (this.disposed) {
      throw new Error(SHELL_UNAVAILABLE_ERROR);
    }

    if (!this.window || this.window.isDestroyed()) {
      const window = this.options.adapters.createWindow();
      this.window = window;
      window.on('closed', () => {
        if (this.window === window) {
          this.window = undefined;
        }
      });
      await window.loadFile(this.options.mainWindowHtmlPath);
      if (this.disposed || this.window !== window || window.isDestroyed()) {
        throw new Error(SHELL_UNAVAILABLE_ERROR);
      }
    }

    const window = this.window;
    if (!window || window.isDestroyed()) {
      throw new Error(SHELL_UNAVAILABLE_ERROR);
    }

    window.show();
    window.focus();
    if (this.lastStatus) {
      window.webContents.send(STATUS_PUSH_CHANNEL, this.lastStatus);
    }
    return { shown: true };
  }

  refresh(): Promise<DesktopShellStatus> {
    if (this.disposed) {
      return this.refreshInFlight ?? Promise.reject(new Error(SHELL_UNAVAILABLE_ERROR));
    }

    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    const refresh = Promise.resolve()
      .then(() => this.options.statusSource.getStatus())
      .then((status) => {
        if (this.disposed) {
          return status;
        }

        this.lastStatus = status;
        const health = this.healthMonitor.evaluate(status, this.options.now?.() ?? Date.now());
        this.tray.setToolTip(formatTrayTooltip(status, health.activeAlerts));
        this.tray.setContextMenu(
          this.options.adapters.buildMenu(this.buildMenuItems(status, health.activeAlerts)),
        );
        for (const alert of health.newAlerts) {
          this.showHealthNotification(alert);
        }
        if (this.window && !this.window.isDestroyed() && this.window.isVisible()) {
          this.window.webContents.send(STATUS_PUSH_CHANNEL, status);
        }
        return status;
      });
    this.refreshInFlight = refresh;
    refresh.then(
      () => this.clearRefreshInFlight(refresh),
      () => this.clearRefreshInFlight(refresh),
    );
    return refresh;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.permissionRefreshPending = false;
    this.permissionRefreshToken += 1;
    clearInterval(this.refreshInterval);
    try {
      this.tray.destroy();
    } catch {
      this.reportSafeError();
    }
  }

  private buildMenuItems(
    status: DesktopShellStatus,
    activeAlerts: readonly DesktopHealthAlert[],
  ): DesktopShellMenuItem[] {
    const blocked = isCaptureBlockedByPermissions(status);
    return [
      {
        click: () => {
          this.runInBackground(() => this.showMainWindow());
        },
        kind: 'action',
        label: `打开 ${productIdentity.displayName}`,
      },
      ...activeAlerts.map<DesktopShellMenuItem>((alert) => ({
        enabled: false,
        kind: 'action',
        label: `注意：${alert.trayLabel}`,
      })),
      { kind: 'separator' },
      {
        click: () => {
          this.runInBackground(async () => {
            await this.options.actions.pauseCapture();
            await this.refresh();
          });
        },
        enabled: status.captureState === 'running' && !status.capturePaused,
        kind: 'action',
        label: '暂停采集',
      },
      {
        click: () => {
          this.runInBackground(async () => {
            await this.options.actions.resumeCapture();
            await this.refresh();
          });
        },
        enabled:
          status.captureState === 'paused' &&
          status.capturePaused &&
          status.capturePauseReason !== 'backpressure' &&
          !blocked,
        kind: 'action',
        label: '继续采集',
      },
      { kind: 'separator' },
      {
        click: () => {
          this.runInBackground(async () => {
            await this.options.actions.resumeProviderSync();
            await this.refresh();
          });
        },
        enabled: status.syncGate.state !== 'open',
        kind: 'action',
        label: '恢复同步',
      },
      {
        click: () => {
          this.runInBackground(async () => {
            await this.options.actions.requeueTerminalJobs();
            await this.refresh();
          });
        },
        enabled: status.syncFailed + status.syncBlocked > 0,
        kind: 'action',
        label: '重新处理失败项',
      },
      { kind: 'separator' },
      {
        click: () => {
          this.runInBackground(() =>
            this.openPrivacySettings(() => this.options.actions.openScreenRecordingSettings()),
          );
        },
        kind: 'action',
        label: `屏幕录制：${formatPermissionLabel(status.screenRecording)}`,
      },
      {
        click: () => {
          this.runInBackground(() =>
            this.openPrivacySettings(() => this.options.actions.openAccessibilitySettings()),
          );
        },
        kind: 'action',
        label: `辅助功能：${formatPermissionLabel(status.accessibility)}`,
      },
      {
        click: () => {
          this.runInBackground(async () => {
            await this.options.actions.refreshPermissions();
            await this.refresh();
          });
        },
        kind: 'action',
        label: '刷新权限',
      },
      { kind: 'separator' },
      {
        click: () => {
          this.runInBackground(async () => {
            this.options.adapters.quit();
          });
        },
        kind: 'action',
        label: `退出 ${productIdentity.displayName}`,
      },
    ];
  }

  private async openPrivacySettings(openSettings: () => Promise<void>): Promise<void> {
    await this.showMainWindow();
    if (this.disposed || !this.window || this.window.isDestroyed()) {
      return;
    }

    await openSettings();
    if (this.disposed || !this.window || this.window.isDestroyed()) {
      return;
    }

    this.armPermissionRefreshOnWindowFocus(this.window);
  }

  private armPermissionRefreshOnWindowFocus(window: DesktopShellWindow): number | undefined {
    if (this.permissionRefreshPending) {
      return undefined;
    }

    this.permissionRefreshPending = true;
    const token = ++this.permissionRefreshToken;
    window.once('focus', () => {
      if (
        this.disposed ||
        !this.permissionRefreshPending ||
        token !== this.permissionRefreshToken ||
        this.window !== window ||
        window.isDestroyed()
      ) {
        return;
      }

      this.permissionRefreshPending = false;
      this.runInBackground(async () => {
        await this.options.actions.refreshPermissions();
        await this.refresh();
      });
    });
    return token;
  }

  private clearRefreshInFlight(refresh: Promise<DesktopShellStatus>): void {
    if (this.refreshInFlight === refresh) {
      this.refreshInFlight = undefined;
    }
  }

  private showHealthNotification(alert: DesktopHealthAlert): void {
    try {
      this.options.adapters.showNotification?.({ body: alert.body, title: alert.title });
    } catch {
      this.reportSafeError();
    }
  }

  private runInBackground(operation: () => Promise<unknown>): void {
    void Promise.resolve()
      .then(operation)
      .catch(() => this.reportSafeError());
  }

  private reportSafeError(): void {
    try {
      this.options.onSafeError?.(SAFE_SHELL_OPERATION_ERROR);
    } catch {
      // A reporting callback is observational and cannot destabilize the shell.
    }
  }
}
