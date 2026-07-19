import type { SafeOperationalError } from '../storage/index';
import type {
  HelperCaptureIdentity,
  HelperCapturePolicy,
  HelperEnvelope,
  HelperToMainType,
  MainToHelperType,
} from './protocol/types';

export type CaptureHelperState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'exited';

export type CaptureHelperStatus = {
  state: CaptureHelperState;
  lastSafeError?: SafeOperationalError;
  policyHash?: string;
  policyVersion?: string;
  updatedAt?: string;
};

export type CaptureHelperTermination = {
  type: 'process_exit';
  reason: 'process_crashed' | 'unknown';
  code: number | null;
};

export type CaptureHelperTransportEvent =
  | { type: 'envelope'; envelope: HelperEnvelope<HelperToMainType> }
  | CaptureHelperTermination;

export type CaptureHelperTransportObserver = {
  handle(event: CaptureHelperTransportEvent): Promise<void>;
};

export type HelperPermissionSnapshot = {
  accessibility: HelperEnvelope<'permission.status'>['payload']['accessibility'];
  screenRecording: HelperEnvelope<'permission.status'>['payload']['screenCapture'];
};

export type HelperPermissionCommandOptions = {
  timeoutMs?: number;
};

export type CaptureHelperClient = {
  start(observer: CaptureHelperTransportObserver): Promise<void>;
  stop(): Promise<void>;
  configureCapture(policy: HelperCapturePolicy, identity?: HelperCaptureIdentity): Promise<void>;
  beginCapture(reason: 'runtime_started' | 'user_resumed'): Promise<void>;
  pauseCapture(): Promise<void>;
  resumeCapture(): Promise<void>;
};

export type CaptureHelperCommandClient = {
  sendCommand(command: HelperEnvelope<MainToHelperType>): Promise<void>;
  refreshPermissions(options?: HelperPermissionCommandOptions): Promise<HelperPermissionSnapshot>;
  requestScreenRecordingPermission(
    options?: HelperPermissionCommandOptions,
  ): Promise<HelperPermissionSnapshot>;
};
