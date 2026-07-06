import type { DesktopRuntime, HelperLifecycle, RuntimeSnapshot, RuntimeStatus } from './types';

export type StartupRecoveryLifecycle = {
  recover(): Promise<void>;
};

export type AssetReconciliationLifecycle = {
  reconcile(): Promise<void>;
};

export type DesktopRuntimeOptions = {
  helper: HelperLifecycle;
  startupRecovery?: StartupRecoveryLifecycle;
  assetReconciliation?: AssetReconciliationLifecycle;
};

export function createDesktopRuntime(options: DesktopRuntimeOptions): DesktopRuntime {
  return new LifecycleController(
    options.helper,
    options.startupRecovery,
    options.assetReconciliation,
  );
}

class LifecycleController implements DesktopRuntime {
  private menuBarActive = false;
  private status: RuntimeStatus = 'stopped';

  constructor(
    private readonly helper: HelperLifecycle,
    private readonly startupRecovery?: StartupRecoveryLifecycle,
    private readonly assetReconciliation?: AssetReconciliationLifecycle,
  ) {}

  getSnapshot(): RuntimeSnapshot {
    return {
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
      await this.helper.start();
      this.status = 'running';
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
