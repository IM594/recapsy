import type { CaptureHelperStatus, HelperLifecycle } from '../helper/index';

export type { HelperLifecycle } from '../helper/index';

export type CaptureStartupRecovery = {
  recover(): Promise<void>;
};

export type CaptureAssetReconciliation = {
  reconcile(): Promise<void>;
};

export type CaptureLifecycleStatus = 'starting' | 'running' | 'paused' | 'stopping' | 'stopped';
export type CapturePauseCause = 'user' | 'backpressure' | 'storage' | 'policy' | 'permission';

export type CaptureLifecycleSnapshot = {
  status: CaptureLifecycleStatus;
  menuBarActive: boolean;
  pauseReason?: CapturePauseCause;
  pauseReasons?: CapturePauseCause[];
  captureHelper?: CaptureHelperStatus;
};

export type CaptureLifecycle = {
  getSnapshot(): CaptureLifecycleSnapshot;
  start(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  setAutomaticPause(active: boolean): Promise<void>;
  setStoragePause(active: boolean): Promise<void>;
  setPermissionPause(active: boolean): Promise<void>;
  setPolicyPause(active: boolean): Promise<void>;
  handleLastWindowClosed(): Promise<void>;
  requestQuit(): Promise<void>;
  stop(): Promise<void>;
};

export type CaptureLifecycleOptions = {
  helper: HelperLifecycle;
  startupRecovery?: CaptureStartupRecovery;
  assetReconciliation?: CaptureAssetReconciliation;
  initialPauseCauses?: readonly CapturePauseCause[];
};

export function createCaptureLifecycle(options: CaptureLifecycleOptions): CaptureLifecycle {
  return new LifecycleController(
    options.helper,
    options.startupRecovery,
    options.assetReconciliation,
    options.initialPauseCauses,
  );
}

class LifecycleController implements CaptureLifecycle {
  private captureHelperStatus: CaptureHelperStatus | undefined;
  private menuBarActive = false;
  private readonly pauseCauses: Set<CapturePauseCause>;
  private status: CaptureLifecycleStatus = 'stopped';

  constructor(
    private readonly helper: HelperLifecycle,
    private readonly startupRecovery?: CaptureStartupRecovery,
    private readonly assetReconciliation?: CaptureAssetReconciliation,
    initialPauseCauses: readonly CapturePauseCause[] = [],
  ) {
    this.pauseCauses = new Set(initialPauseCauses);
  }

  getSnapshot(): CaptureLifecycleSnapshot {
    const helperStatus = this.helper.getStatus?.() ?? this.captureHelperStatus;

    const pauseReasons = orderedPauseCauses(this.pauseCauses);
    return {
      ...(helperStatus ? { captureHelper: helperStatus } : {}),
      menuBarActive: this.menuBarActive,
      ...(pauseReasons.length > 0 ? { pauseReasons } : {}),
      ...(this.status === 'paused' && pauseReasons.length > 0
        ? { pauseReason: pauseReasons[0] }
        : {}),
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
      this.captureHelperStatus = this.helper.getStatus?.();
      if (this.captureHelperStatus?.state === 'paused' && this.pauseCauses.size === 0) {
        this.pauseCauses.add('policy');
      }
      this.status = this.pauseCauses.size > 0 ? 'paused' : 'running';
      this.menuBarActive = false;
    } catch (error) {
      this.status = 'stopped';
      throw error;
    }
  }

  async pause(): Promise<void> {
    await this.setPauseCause('user', true);
  }

  async resume(): Promise<void> {
    await this.setPauseCause('user', false);
  }

  async setAutomaticPause(active: boolean): Promise<void> {
    await this.setPauseCause('backpressure', active);
  }

  async setStoragePause(active: boolean): Promise<void> {
    await this.setPauseCause('storage', active);
  }

  async setPermissionPause(active: boolean): Promise<void> {
    await this.setPauseCause('permission', active);
  }

  async setPolicyPause(active: boolean): Promise<void> {
    await this.setPauseCause('policy', active);
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
    this.pauseCauses.clear();

    try {
      await this.helper.shutdown();
    } finally {
      this.status = 'stopped';
    }
  }

  private async setPauseCause(cause: CapturePauseCause, active: boolean): Promise<void> {
    if (this.status === 'stopping' || this.status === 'stopped') {
      if (active) this.pauseCauses.add(cause);
      else this.pauseCauses.delete(cause);
      return;
    }

    const wasPaused = this.pauseCauses.size > 0;
    if (active) this.pauseCauses.add(cause);
    else this.pauseCauses.delete(cause);
    const isPaused = this.pauseCauses.size > 0;

    if (!wasPaused && isPaused && this.status === 'running') {
      await this.helper.pauseCapture();
      this.status = 'paused';
      return;
    }

    if (wasPaused && !isPaused && this.status === 'paused') {
      await this.helper.resumeCapture();
      this.status = 'running';
    }
  }
}

function orderedPauseCauses(causes: ReadonlySet<CapturePauseCause>): CapturePauseCause[] {
  return (['user', 'policy', 'permission', 'storage', 'backpressure'] as const).filter((cause) =>
    causes.has(cause),
  );
}
