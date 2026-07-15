import type { CaptureHelperStatus, HelperLifecycle } from '../helper/index';

export type { HelperLifecycle } from '../helper/index';

export type CaptureStartupRecovery = {
  recover(): Promise<void>;
};

export type CaptureAssetReconciliation = {
  reconcile(): Promise<void>;
};

export type CaptureLifecycleStatus = 'starting' | 'running' | 'paused' | 'stopping' | 'stopped';

export type CaptureLifecycleSnapshot = {
  status: CaptureLifecycleStatus;
  menuBarActive: boolean;
  captureHelper?: CaptureHelperStatus;
};

export type CaptureLifecycle = {
  getSnapshot(): CaptureLifecycleSnapshot;
  start(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  handleLastWindowClosed(): Promise<void>;
  requestQuit(): Promise<void>;
  stop(): Promise<void>;
};

export type CaptureLifecycleOptions = {
  helper: HelperLifecycle;
  startupRecovery?: CaptureStartupRecovery;
  assetReconciliation?: CaptureAssetReconciliation;
};

export function createCaptureLifecycle(options: CaptureLifecycleOptions): CaptureLifecycle {
  return new LifecycleController(
    options.helper,
    options.startupRecovery,
    options.assetReconciliation,
  );
}

class LifecycleController implements CaptureLifecycle {
  private captureHelperStatus: CaptureHelperStatus | undefined;
  private menuBarActive = false;
  private status: CaptureLifecycleStatus = 'stopped';

  constructor(
    private readonly helper: HelperLifecycle,
    private readonly startupRecovery?: CaptureStartupRecovery,
    private readonly assetReconciliation?: CaptureAssetReconciliation,
  ) {}

  getSnapshot(): CaptureLifecycleSnapshot {
    const helperStatus = this.helper.getStatus?.() ?? this.captureHelperStatus;

    return {
      ...(helperStatus ? { captureHelper: helperStatus } : {}),
      menuBarActive: this.menuBarActive,
      status: this.status,
    };
  }

  async start(): Promise<void> {
    if (this.status === 'running' || this.status === 'paused') {
      return;
    }

    this.status = 'starting';

    try {
      await this.startupRecovery?.recover();
      await this.assetReconciliation?.reconcile();
      try {
        await this.helper.start();
      } catch (error) {
        this.captureHelperStatus = {
          lastSafeError: {
            code: 'helper_start_failed',
            message: 'Capture helper failed to start.',
            retryable: true,
          },
          state: 'failed',
        };
        throw error;
      }
      this.status = 'running';
      this.captureHelperStatus = this.helper.getStatus?.();
      this.menuBarActive = false;
    } catch (error) {
      this.status = 'stopped';
      throw error;
    }
  }

  async pause(): Promise<void> {
    if (this.status !== 'running') {
      return;
    }

    await this.helper.pauseCapture();
    this.status = 'paused';
  }

  async resume(): Promise<void> {
    if (this.status !== 'paused') {
      return;
    }

    await this.helper.resumeCapture();
    this.status = 'running';
  }

  async handleLastWindowClosed(): Promise<void> {
    if (this.status === 'running' || this.status === 'paused') {
      this.menuBarActive = true;
    }
  }

  async requestQuit(): Promise<void> {
    await this.stop();
  }

  async stop(): Promise<void> {
    if (this.status === 'stopped') {
      return;
    }

    this.status = 'stopping';
    this.menuBarActive = false;

    try {
      await this.helper.shutdown();
    } finally {
      this.status = 'stopped';
    }
  }
}
