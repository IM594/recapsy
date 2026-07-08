import type { CaptureHelperStatus } from './capture-helper-controller';

export type RuntimeStatus = 'starting' | 'running' | 'paused' | 'stopping' | 'stopped';

export type RuntimeSnapshot = {
  status: RuntimeStatus;
  menuBarActive: boolean;
  captureHelper?: CaptureHelperStatus;
};

export type HelperLifecycle = {
  start(): Promise<void>;
  pauseCapture(): Promise<void>;
  resumeCapture(): Promise<void>;
  shutdown(): Promise<void>;
  getStatus?(): CaptureHelperStatus;
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
