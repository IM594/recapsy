import type { DesktopRuntime, HelperLifecycle, RuntimeSnapshot, RuntimeStatus } from './types';

export type DesktopRuntimeOptions = {
  helper: HelperLifecycle;
};

export function createDesktopRuntime(options: DesktopRuntimeOptions): DesktopRuntime {
  return new LifecycleController(options.helper);
}

class LifecycleController implements DesktopRuntime {
  private menuBarActive = false;
  private status: RuntimeStatus = 'stopped';

  constructor(private readonly helper: HelperLifecycle) {}

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
