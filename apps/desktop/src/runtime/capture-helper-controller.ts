import {
  type CaptureAssetPayload,
  HELPER_PROTOCOL_VERSION,
  type HelperEnvelope,
  type HelperToMainType,
} from '../helper/protocol';
import type {
  AssetAvailabilityState,
  AssetCacheRefRole,
  CapturePrivacyDecision,
  HelperPermissionState,
  OperationalStoreRepository,
  SafeOperationalError,
} from '../storage';
import type { HelperLifecycle } from './types';

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

export type CaptureHelperStartOptions = {
  /** @internal Legacy adapter surface for tests and mock clients. Capture events must be routed to eventIntake. */
  onEvent?(event: CaptureHelperEvent): Promise<void>;
  onEnvelope?(envelope: HelperEnvelope<HelperToMainType>): Promise<void>;
};

export type CaptureHelperClient = {
  start(options?: CaptureHelperStartOptions): Promise<void>;
  stop(): Promise<void>;
  pauseCapture(): Promise<void>;
  resumeCapture(): Promise<void>;
};

export type CaptureHelperControllerOptions = {
  client: CaptureHelperClient;
  deviceId: string;
  eventIntake?: {
    handleEnvelope(envelope: HelperEnvelope<HelperToMainType>): Promise<void>;
  };
  now(): string;
  store: OperationalStoreRepository;
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

export type CaptureHelperController = HelperLifecycle & {
  getStatus(): CaptureHelperStatus;
  ingestEvent(event: CaptureHelperEvent): Promise<void>;
};

export function createCaptureHelperController(
  options: CaptureHelperControllerOptions,
): CaptureHelperController {
  return new StoreBackedCaptureHelperController(options);
}

class StoreBackedCaptureHelperController implements CaptureHelperController {
  private status: CaptureHelperStatus = {
    state: 'idle',
  };
  private started = false;
  private stopped = false;

  constructor(private readonly options: CaptureHelperControllerOptions) {}

  getStatus(): CaptureHelperStatus {
    return cloneStatus(this.status);
  }

  async start(): Promise<void> {
    if (this.started && this.status.state !== 'failed' && this.status.state !== 'exited') {
      return;
    }

    this.status = {
      state: 'starting',
      updatedAt: this.options.now(),
    };
    await this.persistHelperState();

    try {
      await this.options.client.start({
        onEnvelope: this.options.eventIntake
          ? (envelope) => this.options.eventIntake?.handleEnvelope(envelope) ?? Promise.resolve()
          : undefined,
        onEvent: (event) => this.ingestEvent(event),
      });
    } catch (error) {
      const safeError = safeOperationalError(
        'helper_start_failed',
        'Capture helper could not be started.',
        true,
      );
      this.status = {
        lastSafeError: safeError,
        state: 'failed',
        updatedAt: this.options.now(),
      };
      await this.persistHelperState();
      throw new Error(safeError.code);
    }

    this.started = true;
    this.stopped = false;
    this.status = {
      state: 'running',
      updatedAt: this.options.now(),
    };
    await this.persistHelperState();
  }

  async pauseCapture(): Promise<void> {
    if (this.status.state !== 'running') {
      return;
    }

    await this.options.client.pauseCapture();
    this.status = {
      state: 'paused',
      updatedAt: this.options.now(),
    };
    await this.persistHelperState();
  }

  async resumeCapture(): Promise<void> {
    if (this.status.state !== 'paused') {
      return;
    }

    await this.options.client.resumeCapture();
    this.status = {
      state: 'running',
      updatedAt: this.options.now(),
    };
    await this.persistHelperState();
  }

  async shutdown(): Promise<void> {
    if (this.stopped || this.status.state === 'stopped') {
      return;
    }

    this.status = {
      state: 'stopping',
      updatedAt: this.options.now(),
    };
    await this.persistHelperState();
    await this.options.client.stop();
    this.stopped = true;
    this.started = false;
    this.status = {
      state: 'stopped',
      updatedAt: this.options.now(),
    };
    await this.persistHelperState();
  }

  async ingestEvent(event: CaptureHelperEvent): Promise<void> {
    if (this.options.eventIntake) {
      await this.options.eventIntake.handleEnvelope(
        envelopeFromInternalEvent(event, this.options.now()),
      );

      if (event.type === 'captureObserved') {
        return;
      }
    }

    if (event.type === 'unexpectedExit') {
      await this.recordUnexpectedExit(event);
      return;
    }

    this.status = {
      lastSafeError: {
        code: 'capture_event_intake_required',
        message: 'Capture helper event intake is required.',
        retryable: false,
      },
      state: this.status.state === 'paused' ? 'paused' : 'running',
      updatedAt: this.options.now(),
    };
    await this.persistHelperState();
  }

  private async recordUnexpectedExit(
    event: Extract<CaptureHelperEvent, { type: 'unexpectedExit' }>,
  ): Promise<void> {
    const safeError = safeOperationalError(
      'helper_unexpected_exit',
      'Capture helper stopped unexpectedly.',
      true,
    );
    this.status = {
      lastSafeError: safeError,
      state:
        event.reason === 'shutdown_requested' || event.reason === 'quit_requested'
          ? 'stopped'
          : 'exited',
      updatedAt: this.options.now(),
    };
    await this.persistHelperState();
  }

  private async persistHelperState(): Promise<void> {
    const lastSafeError = this.status.lastSafeError ? { ...this.status.lastSafeError } : undefined;

    await this.options.store.setHelperState({
      connectionKind: 'managed_helper',
      lastSafeError,
      permissions: {
        accessibility: 'unknown' satisfies HelperPermissionState,
        screenRecording: 'unknown' satisfies HelperPermissionState,
      },
      restartCount: 0,
      updatedAt: this.status.updatedAt ?? this.options.now(),
    });
  }
}

function safeOperationalError(
  code: string,
  message: string,
  retryable: boolean,
): SafeOperationalError {
  return {
    code,
    message,
    retryable,
  };
}

function cloneStatus(status: CaptureHelperStatus): CaptureHelperStatus {
  return {
    ...status,
    ...(status.lastSafeError ? { lastSafeError: { ...status.lastSafeError } } : {}),
  };
}

function envelopeFromInternalEvent(
  event: CaptureHelperEvent,
  sentAt: string,
): HelperEnvelope<HelperToMainType> {
  if (event.type === 'unexpectedExit') {
    return {
      correlationId: null,
      messageId: `internal_${sentAt}_helper_exit`,
      payload: {
        code: event.code ?? null,
        reason: event.reason,
      },
      protocolVersion: HELPER_PROTOCOL_VERSION,
      sentAt,
      type: 'helper.exiting',
    } as HelperEnvelope<'helper.exiting'>;
  }

  const asset: CaptureAssetPayload = {
    hash: event.asset.hash,
    mimeType: event.asset.mimeType,
    ref: event.asset.assetRefId,
    role: helperAssetRole(event.asset.role),
    sizeBytes: event.asset.sizeBytes,
  };

  return {
    correlationId: null,
    messageId: `internal_${event.captureId}`,
    payload: {
      assets: [asset],
      captureId: event.captureId,
      context: {
        ...(event.bundleId
          ? {
              app: {
                bundleId: event.bundleId,
                name: event.sourceAppName,
              },
            }
          : {}),
        observedAt: event.observedAt,
        policy: {
          decision: helperPolicyDecision(event.privacyDecision.action),
          version: event.privacyDecision.policyVersion,
        },
      },
      manifest: {
        hash: event.asset.hash,
        mimeType: 'application/json',
        ref: `manifest:${event.captureId}`,
        role: 'manifest',
        sizeBytes: 0,
      },
      observedAt: event.observedAt,
    },
    protocolVersion: HELPER_PROTOCOL_VERSION,
    sentAt,
    type: 'capture.result',
  } as HelperEnvelope<'capture.result'>;
}

function helperAssetRole(role: CaptureHelperAssetRef['role']): CaptureAssetPayload['role'] {
  return role === 'capture_thumbnail' ? 'thumbnail' : 'screenshot';
}

function helperPolicyDecision(
  action: CapturePrivacyDecision['action'],
): 'allow' | 'redact_context' | 'block_ocr' {
  return action === 'redact_context' || action === 'block_ocr' ? action : 'allow';
}
