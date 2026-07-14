import type { CaptureHelperStatus } from '../helper/public';

export type { CaptureHelperStatus, HelperLifecycle } from '../helper/public';

export type RuntimeStatus = 'starting' | 'running' | 'paused' | 'stopping' | 'stopped';

export type RuntimeSnapshot = {
  status: RuntimeStatus;
  menuBarActive: boolean;
  captureHelper?: CaptureHelperStatus;
};

export type DesktopRuntime = {
  getSnapshot(): RuntimeSnapshot;
  start(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  handleLastWindowClosed(): Promise<void>;
  requestQuit(): Promise<void>;
  stop(): Promise<void>;
};
