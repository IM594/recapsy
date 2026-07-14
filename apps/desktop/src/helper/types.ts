import type {
  AssetAvailabilityState,
  AssetCacheRefRole,
  CapturePrivacyDecision,
  SafeOperationalError,
} from '../storage/public';
import type { HelperEnvelope, HelperToMainType, MainToHelperType } from './protocol';

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
  updatedAt?: string;
};

export type HelperLifecycle = {
  start(): Promise<void>;
  pauseCapture(): Promise<void>;
  resumeCapture(): Promise<void>;
  shutdown(): Promise<void>;
  getStatus?(): CaptureHelperStatus;
};

export type CaptureHelperAssetRef = {
  assetRefId: string;
  role: Extract<AssetCacheRefRole, 'capture_original' | 'capture_thumbnail' | 'ocr_input'>;
  hash: string;
  mimeType: string;
  sizeBytes: number;
  localAccessKey: string;
  availabilityState?: AssetAvailabilityState;
  contentAddress?: string;
};

export type CaptureHelperEvent =
  | {
      type: 'captureObserved';
      workspaceId: string;
      captureId: string;
      capturedAt: string;
      observedAt: string;
      sourceAppName: string;
      captureType: 'screen' | 'window';
      asset: CaptureHelperAssetRef;
      privacyDecision: CapturePrivacyDecision;
      metadata?: Record<string, unknown>;
      userId?: string;
      bundleId?: string;
      contextFingerprint?: string;
      contextConfidence?: 'high' | 'medium' | 'low' | 'unknown';
    }
  | {
      type: 'unexpectedExit';
      reason: 'process_crashed' | 'quit_requested' | 'shutdown_requested' | 'unknown';
      code?: number | null;
      error?: string;
    };

export type CaptureHelperStartOptions = {
  /** @internal Legacy adapter surface for tests and mock clients. Capture events must be routed to eventHandler. */
  onEvent?(event: CaptureHelperEvent): Promise<void>;
  onEnvelope?(envelope: HelperEnvelope<HelperToMainType>): Promise<void>;
};

export type CaptureHelperClient = {
  start(options?: CaptureHelperStartOptions): Promise<void>;
  stop(): Promise<void>;
  beginCapture(reason: 'runtime_started' | 'user_resumed'): Promise<void>;
  pauseCapture(): Promise<void>;
  resumeCapture(): Promise<void>;
};

export type CaptureHelperCommandClient = {
  sendCommand(command: HelperEnvelope<MainToHelperType>): Promise<void>;
};
