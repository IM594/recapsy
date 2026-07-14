import {
  type CaptureAssetPayload,
  type CaptureHelperAssetRef,
  type CaptureHelperClient,
  type CaptureHelperEvent,
  type CaptureHelperStatus,
  HELPER_PROTOCOL_VERSION,
  type HelperEnvelope,
  type HelperLifecycle,
  type HelperToMainType,
} from '../helper/public';
import type {
  CapturePrivacyDecision,
  HelperPermissionState,
  OperationalStoreRepository,
  SafeOperationalError,
} from '../storage/public';

export type {
  CaptureHelperAssetRef,
  CaptureHelperClient,
  CaptureHelperEvent,
  CaptureHelperStartOptions,
  CaptureHelperState,
  CaptureHelperStatus,
} from '../helper/public';

export type CaptureHelperControllerOptions = {
  client: CaptureHelperClient;
  deviceId: string;
  eventHandler?: {
    handleEnvelope(envelope: HelperEnvelope<HelperToMainType>): Promise<void>;
  };
  now(): string;
  store: OperationalStoreRepository;
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
        onEnvelope: this.options.eventHandler
          ? (envelope) => this.options.eventHandler?.handleEnvelope(envelope) ?? Promise.resolve()
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

    // Spawning the helper only wires up the process; the capture engine stays
    // idle until it is explicitly told to begin. Now that the process is
    // running, drive it to start capturing. Failure paths above return early,
    // so this only fires when the helper actually reached `running`.
    await this.options.client.beginCapture('runtime_started');
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
    if (this.options.eventHandler) {
      // The event handler is the sole writer of `helper_state` for
      // envelope-derived facts (see `helper-event-handler.ts`). Only
      // mirror the transition into this controller's own in-memory status
      // (used by `getStatus()`) — do not persist a second time here, or the
      // last writer silently clobbers fields (e.g. permissions) the other
      // side owns.
      await this.options.eventHandler.handleEnvelope(
        envelopeFromInternalEvent(event, this.options.now()),
      );

      if (event.type === 'unexpectedExit') {
        this.applyUnexpectedExitStatus(event);
      }
      return;
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

  private applyUnexpectedExitStatus(
    event: Extract<CaptureHelperEvent, { type: 'unexpectedExit' }>,
  ): void {
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
  }

  private async recordUnexpectedExit(
    event: Extract<CaptureHelperEvent, { type: 'unexpectedExit' }>,
  ): Promise<void> {
    this.applyUnexpectedExitStatus(event);
    await this.persistHelperState();
  }

  /**
   * `helper_state` is a single-row table also written by the event handler
   * for envelope-derived facts (permissions, envelope-sourced errors). This
   * controller only owns controller-driven transitions (start/pause/resume/
   * shutdown), so it reads the current row first and carries forward
   * whatever the handler already recorded instead of resetting it to
   * defaults on every write.
   */
  private async persistHelperState(): Promise<void> {
    const lastSafeError = this.status.lastSafeError ? { ...this.status.lastSafeError } : undefined;
    const existing = await this.options.store.getHelperState();

    await this.options.store.setHelperState({
      connectionKind: existing?.connectionKind ?? 'managed_helper',
      lastSafeError,
      permissions: existing?.permissions ?? {
        accessibility: 'unknown' satisfies HelperPermissionState,
        screenRecording: 'unknown' satisfies HelperPermissionState,
      },
      restartCount: existing?.restartCount ?? 0,
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
  switch (role) {
    case 'capture_thumbnail':
      return 'thumbnail';
    case 'capture_original':
      return 'screenshot';
    case 'ocr_input':
      // The wire protocol has no asset role for this — it fails closed
      // instead of silently mislabeling it as a screenshot.
      throw new Error('capture_helper_legacy_adapter_ocr_input_unsupported');
  }
}

function helperPolicyDecision(
  action: CapturePrivacyDecision['action'],
): 'allow' | 'redact_context' | 'block_ocr' {
  return action === 'redact_context' || action === 'block_ocr' ? action : 'allow';
}
