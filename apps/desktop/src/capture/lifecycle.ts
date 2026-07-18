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
  private lifecycleGeneration = 0;
  private menuBarActive = false;
  private readonly pauseCauses: Set<CapturePauseCause>;
  private startInFlight: Promise<void> | undefined;
  private status: CaptureLifecycleStatus = 'stopped';
  private stopInFlight: Promise<void> | undefined;

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

  start(): Promise<void> {
    if (this.startInFlight) {
      return this.startInFlight;
    }

    const stop = this.stopInFlight ?? (this.status === 'stopping' ? this.stop() : undefined);
    const run = stop ? stop.then(() => this.startInternal()) : this.startInternal();
    const tracked = run.finally(() => {
      if (this.startInFlight === tracked) {
        this.startInFlight = undefined;
      }
    });
    this.startInFlight = tracked;
    return tracked;
  }

  private async startInternal(): Promise<void> {
    if (this.status === 'running' || this.status === 'paused') {
      return;
    }

    const lifecycleGeneration = ++this.lifecycleGeneration;
    this.status = 'starting';

    try {
      await this.startupRecovery?.recover();
      if (!this.isLifecycleCurrent(lifecycleGeneration)) return;
      await this.assetReconciliation?.reconcile();
      if (!this.isLifecycleCurrent(lifecycleGeneration)) return;
      try {
        await this.helper.start();
      } catch (error) {
        if (!this.isLifecycleCurrent(lifecycleGeneration)) return;
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
      if (!this.isLifecycleCurrent(lifecycleGeneration)) return;
      this.captureHelperStatus = this.helper.getStatus?.();
      if (this.captureHelperStatus?.state === 'paused' && this.pauseCauses.size === 0) {
        this.pauseCauses.add('policy');
      }
      this.status = this.pauseCauses.size > 0 ? 'paused' : 'running';
      this.menuBarActive = false;
    } catch (error) {
      if (!this.isLifecycleCurrent(lifecycleGeneration)) return;
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
    await this.setPauseCause('policy', active, false);
  }

  async handleLastWindowClosed(): Promise<void> {
    if (this.status === 'running' || this.status === 'paused') {
      this.menuBarActive = true;
    }
  }

  async requestQuit(): Promise<void> {
    await this.stop();
  }

  stop(): Promise<void> {
    if (this.stopInFlight) {
      return this.stopInFlight;
    }

    this.startInFlight = undefined;
    const run = this.stopInternal();
    const tracked = run.finally(() => {
      if (this.stopInFlight === tracked) {
        this.stopInFlight = undefined;
      }
    });
    this.stopInFlight = tracked;
    return tracked;
  }

  private async stopInternal(): Promise<void> {
    if (this.status === 'stopped') {
      return;
    }

    const lifecycleGeneration = ++this.lifecycleGeneration;
    this.status = 'stopping';
    this.menuBarActive = false;
    this.pauseCauses.clear();

    await this.helper.shutdown();
    if (this.isLifecycleCurrent(lifecycleGeneration)) {
      this.status = 'stopped';
    }
  }

  private async setPauseCause(
    cause: CapturePauseCause,
    active: boolean,
    commandHelper = true,
  ): Promise<void> {
    if (this.status === 'stopping' || this.status === 'stopped') {
      if (active) this.pauseCauses.add(cause);
      else this.pauseCauses.delete(cause);
      return;
    }

    const wasPaused = this.pauseCauses.size > 0;
    if (active) this.pauseCauses.add(cause);
    else this.pauseCauses.delete(cause);
    const isPaused = this.pauseCauses.size > 0;

    if (!commandHelper) {
      if (this.status === 'running' || this.status === 'paused') {
        this.status = isPaused ? 'paused' : 'running';
      }
      return;
    }

    const lifecycleGeneration = this.lifecycleGeneration;

    if (!wasPaused && isPaused && this.status === 'running') {
      await this.helper.pauseCapture();
      if (!this.isLifecycleCurrent(lifecycleGeneration)) return;
      this.status = 'paused';
      return;
    }

    if (wasPaused && !isPaused && this.status === 'paused') {
      await this.helper.resumeCapture();
      if (!this.isLifecycleCurrent(lifecycleGeneration)) return;
      this.status = 'running';
    }
  }

  private isLifecycleCurrent(lifecycleGeneration: number): boolean {
    return lifecycleGeneration === this.lifecycleGeneration;
  }
}

function orderedPauseCauses(causes: ReadonlySet<CapturePauseCause>): CapturePauseCause[] {
  return (['user', 'policy', 'permission', 'storage', 'backpressure'] as const).filter((cause) =>
    causes.has(cause),
  );
}
