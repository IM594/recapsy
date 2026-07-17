import {
  type CaptureHelperCommandClient,
  HELPER_PROTOCOL_VERSION,
  type HelperEnvelope,
  type HelperProtocolError,
  type HelperProtocolResult,
  type HelperToMainType,
  type MainToHelperPayloadByType,
  type MainToHelperType,
} from '../helper/index';
import {
  type BackpressureConfig,
  type HelperPermissionState,
  type HelperRuntimeState,
  type SafeOperationalError,
  evaluateOperationalStoreBackpressure,
} from '../storage/index';
import { projectCaptureOutboxEntry } from './outbox-entry';
import type { CaptureIntakeStore, HelperStateStore } from './store';

export type { CaptureHelperCommandClient } from '../helper/index';

export type CaptureHelperEventStatus = {
  lastObservedAt?: string;
  lastSafeError?: SafeOperationalError;
  lastSkippedCapture?: {
    captureId: string;
    reason: string;
    observedAt: string;
  };
  permissions?: {
    accessibility: HelperPermissionState;
    screenRecording: HelperPermissionState;
  };
  permissionStatusSequence?: number;
};

export type CaptureHelperEventHandler = {
  getStatus(): CaptureHelperEventStatus;
  handleEnvelope(envelope: HelperEnvelope<HelperToMainType>): Promise<void>;
  handleProtocolResult(result: HelperProtocolResult<HelperEnvelope>): Promise<void>;
  subscribeToPermissionStatus(listener: (status: CaptureHelperEventStatus) => void): () => void;
};

export type CaptureHelperEventHandlerOptions = {
  backpressure: BackpressureConfig;
  client: CaptureHelperCommandClient;
  deviceId: string;
  now(): string;
  store: CaptureIntakeStore & HelperStateStore;
  workspaceId: string;
};

type CaptureNackCode = MainToHelperPayloadByType['capture.nack']['code'];

export function createCaptureHelperEventHandler(
  options: CaptureHelperEventHandlerOptions,
): CaptureHelperEventHandler {
  return new StoreBackedCaptureHelperEventHandler(options);
}

class StoreBackedCaptureHelperEventHandler implements CaptureHelperEventHandler {
  private messageSequence = 0;
  private readonly permissionStatusListeners = new Set<
    (status: CaptureHelperEventStatus) => void
  >();
  private status: CaptureHelperEventStatus = {};

  constructor(private readonly options: CaptureHelperEventHandlerOptions) {}

  getStatus(): CaptureHelperEventStatus {
    return {
      ...this.status,
      ...(this.status.lastSafeError ? { lastSafeError: { ...this.status.lastSafeError } } : {}),
      ...(this.status.lastSkippedCapture
        ? { lastSkippedCapture: { ...this.status.lastSkippedCapture } }
        : {}),
      ...(this.status.permissions ? { permissions: { ...this.status.permissions } } : {}),
    };
  }

  subscribeToPermissionStatus(listener: (status: CaptureHelperEventStatus) => void): () => void {
    this.permissionStatusListeners.add(listener);
    return () => {
      this.permissionStatusListeners.delete(listener);
    };
  }

  async handleEnvelope(envelope: HelperEnvelope<HelperToMainType>): Promise<void> {
    try {
      switch (envelope.type) {
        case 'capture.result':
          await this.handleCaptureResult(narrowHelperEnvelope(envelope, 'capture.result'));
          return;
        case 'capture.skipped':
          await this.recordSkippedCapture(narrowHelperEnvelope(envelope, 'capture.skipped'));
          return;
        case 'capture.error':
          await this.recordCaptureError(narrowHelperEnvelope(envelope, 'capture.error'));
          return;
        case 'helper.exiting':
          await this.recordHelperExit(narrowHelperEnvelope(envelope, 'helper.exiting'));
          return;
        case 'permission.status':
          await this.recordPermissionStatus(narrowHelperEnvelope(envelope, 'permission.status'));
          return;
        case 'helper.heartbeat':
        case 'helper.hello':
        case 'helper.status':
          this.status = {
            ...this.status,
            lastObservedAt: envelope.sentAt,
          };
          return;
      }
    } catch {
      await this.recordUnexpectedEventFailure(envelope);
    }
  }

  async handleProtocolResult(result: HelperProtocolResult<HelperEnvelope>): Promise<void> {
    if (result.ok) {
      if (!isHelperToMainType(result.envelope.type)) {
        await this.sendProtocolNack({
          code: 'schema_mismatch',
          message: 'Helper message direction is invalid.',
          messageId: result.envelope.messageId,
        });
        return;
      }

      await this.handleEnvelope(result.envelope as HelperEnvelope<HelperToMainType>);
      return;
    }

    await this.sendProtocolNack(result.error);
  }

  private async handleCaptureResult(envelope: HelperEnvelope<'capture.result'>): Promise<void> {
    const captureId = envelope.payload.captureId;
    const backpressure = await evaluateCaptureBackpressure(this.options);

    if (backpressure.action === 'pause') {
      await this.sendNack(envelope, 'backpressure', 'Capture queue is applying backpressure.');
      await this.sendCommand(envelope, 'capture.pause', {
        reason: 'backpressure',
      });
      return;
    }

    try {
      const entry = projectCaptureOutboxEntry({
        deviceId: this.options.deviceId,
        payload: envelope.payload,
        workspaceId: this.options.workspaceId,
      });

      if (!entry) {
        await this.sendNack(envelope, 'asset_unavailable', 'Capture asset is unavailable.');
        return;
      }

      const result = await this.options.store.createCaptureOutboxEntry(entry);

      if (!result.ok) {
        await this.sendNack(
          envelope,
          mapStoreErrorToNackCode(result.error.code),
          safeNackMessage(result.error.code),
        );
        this.status = {
          ...this.status,
          lastObservedAt: envelope.sentAt,
          lastSafeError: {
            code: result.error.code,
            message: safeNackMessage(result.error.code),
            retryable: result.error.code === 'capacity_exceeded',
          },
        };
        return;
      }

      this.status = {
        ...this.status,
        lastObservedAt: envelope.sentAt,
        lastSafeError: undefined,
      };
      await this.sendCommand(envelope, 'capture.ack', {
        captureId,
      });
    } catch {
      const safeError = safeOperationalError(
        'storage_unavailable',
        safeNackMessage('storage_unavailable'),
        true,
      );
      this.status = {
        ...this.status,
        lastObservedAt: envelope.sentAt,
        lastSafeError: safeError,
      };
      await this.sendNack(envelope, 'storage_unavailable', safeError.message);
    }
  }

  private async recordSkippedCapture(envelope: HelperEnvelope<'capture.skipped'>): Promise<void> {
    this.status = {
      ...this.status,
      lastObservedAt: envelope.sentAt,
      lastSkippedCapture: {
        captureId: envelope.payload.captureId,
        observedAt: envelope.payload.observedAt,
        reason: envelope.payload.reason,
      },
    };
  }

  private async recordCaptureError(envelope: HelperEnvelope<'capture.error'>): Promise<void> {
    const safeError = safeCaptureError(envelope.payload.code);
    this.status = {
      ...this.status,
      lastObservedAt: envelope.sentAt,
      lastSafeError: safeError,
    };
    await this.persistHelperState();
  }

  private async recordHelperExit(envelope: HelperEnvelope<'helper.exiting'>): Promise<void> {
    const safeError = safeOperationalError(
      'helper_unexpected_exit',
      'Capture helper stopped unexpectedly.',
      true,
    );
    this.status = {
      ...this.status,
      lastObservedAt: envelope.sentAt,
      lastSafeError: safeError,
    };
    await this.persistHelperState();
  }

  private async recordPermissionStatus(
    envelope: HelperEnvelope<'permission.status'>,
  ): Promise<void> {
    this.status = {
      ...this.status,
      lastObservedAt: envelope.sentAt,
      permissions: {
        accessibility: envelope.payload.accessibility,
        screenRecording: envelope.payload.screenCapture,
      },
      permissionStatusSequence: (this.status.permissionStatusSequence ?? 0) + 1,
    };
    this.notifyPermissionStatusListeners();
    await this.persistHelperState();
  }

  private notifyPermissionStatusListeners(): void {
    const status = this.getStatus();
    for (const listener of this.permissionStatusListeners) {
      try {
        listener(status);
      } catch {
        // Permission observers are read-only consumers and cannot disrupt
        // capture-event persistence or later observers.
      }
    }
  }

  private async recordUnexpectedEventFailure(envelope: HelperEnvelope): Promise<void> {
    const safeError = safeOperationalError('unknown', 'Capture event could not be accepted.', true);
    this.status = {
      ...this.status,
      lastObservedAt: envelope.sentAt,
      lastSafeError: safeError,
    };

    if (isCaptureEnvelope(envelope)) {
      await this.sendNack(envelope, 'unknown', safeError.message);
    }
  }

  /**
   * `helper_state` is a single-row table also written by
   * `CaptureHelperController` for controller-driven transitions (start,
   * pause, resume, shutdown). `setHelperState` replaces the whole row, so
   * this reads the current row first and only overwrites the fields this
   * handler actually owns (`lastSafeError`, `permissions`), carrying the rest
   * forward instead of resetting them to defaults.
   */
  private async persistHelperState(): Promise<void> {
    const existing = await this.options.store.getHelperState();
    const helperState: HelperRuntimeState = {
      connectionKind: existing?.connectionKind ?? 'managed_helper',
      lastSafeError: this.status.lastSafeError ? { ...this.status.lastSafeError } : undefined,
      permissions: this.status.permissions ??
        existing?.permissions ?? {
          accessibility: 'unknown',
          screenRecording: 'unknown',
        },
      restartCount: existing?.restartCount ?? 0,
      updatedAt: this.options.now(),
    };

    await this.options.store.setHelperState(helperState);
  }

  private async sendNack(
    incoming: HelperEnvelope,
    code: CaptureNackCode,
    message: string,
  ): Promise<void> {
    const captureId = isCaptureEnvelope(incoming) ? incoming.payload.captureId : undefined;
    await this.sendCommand(incoming, 'capture.nack', {
      ...(captureId ? { captureId } : {}),
      code,
      message,
    });
  }

  private async sendProtocolNack(error: HelperProtocolError): Promise<void> {
    this.messageSequence += 1;
    await this.options.client.sendCommand({
      correlationId: error.messageId ?? error.correlationId ?? null,
      messageId: `main_${this.messageSequence}`,
      payload: {
        ...(error.captureId ? { captureId: error.captureId } : {}),
        code: 'schema_mismatch',
        message: 'Capture helper message could not be accepted.',
      },
      protocolVersion: HELPER_PROTOCOL_VERSION,
      sentAt: this.options.now(),
      type: 'capture.nack',
    } as HelperEnvelope<'capture.nack'>);
  }

  private async sendCommand<TType extends MainToHelperType>(
    incoming: HelperEnvelope,
    type: TType,
    payload: MainToHelperPayloadByType[TType],
  ): Promise<void> {
    this.messageSequence += 1;
    await this.options.client.sendCommand({
      correlationId: incoming.messageId,
      messageId: `main_${this.messageSequence}`,
      payload,
      protocolVersion: HELPER_PROTOCOL_VERSION,
      sentAt: this.options.now(),
      type,
    } as HelperEnvelope<TType>);
  }
}

async function evaluateCaptureBackpressure(options: CaptureHelperEventHandlerOptions) {
  return evaluateOperationalStoreBackpressure(
    await options.store.getBackpressureSnapshot(options.workspaceId),
    options.backpressure,
  );
}

function mapStoreErrorToNackCode(code: string): CaptureNackCode {
  if (code === 'capacity_exceeded') {
    return 'backpressure';
  }

  if (
    code === 'idempotency_key_conflict' ||
    code === 'outbox_job_id_conflict' ||
    code === 'asset_ref_conflict'
  ) {
    return 'conflict';
  }

  return 'storage_unavailable';
}

function safeNackMessage(code: string): string {
  if (code === 'capacity_exceeded') {
    return 'Capture queue is applying backpressure.';
  }

  if (
    code === 'idempotency_key_conflict' ||
    code === 'outbox_job_id_conflict' ||
    code === 'asset_ref_conflict'
  ) {
    return 'Capture delivery conflicts with an existing local record.';
  }

  return 'Capture could not be queued locally.';
}

function safeCaptureError(code: string): SafeOperationalError {
  switch (code) {
    case 'asset_write_failed':
      return {
        code,
        message: 'Capture asset could not be written.',
        retryable: true,
      };
    case 'permission_missing':
    case 'permission_revoked':
      return {
        code,
        message: 'Capture permission is not available.',
        retryable: false,
      };
    case 'helper_unavailable':
      return {
        code,
        message: 'Capture helper is unavailable.',
        retryable: true,
      };
    case 'capture_failed':
      return {
        code,
        message: 'Capture failed.',
        retryable: true,
      };
    default:
      return {
        code: 'unknown',
        message: 'Capture helper reported an error.',
        retryable: true,
      };
  }
}

function safeOperationalError(
  code: string,
  message: string,
  retryable: boolean,
): SafeOperationalError {
  return { code, message, retryable };
}

function isCaptureEnvelope(envelope: HelperEnvelope): envelope is HelperEnvelope<'capture.result'> {
  return envelope.type === 'capture.result';
}

function narrowHelperEnvelope<TType extends HelperToMainType>(
  envelope: HelperEnvelope<HelperToMainType>,
  type: TType,
): HelperEnvelope<TType> {
  if (envelope.type !== type) {
    throw new Error('helper_envelope_type_mismatch');
  }

  return envelope as HelperEnvelope<TType>;
}

function isHelperToMainType(type: string): type is HelperToMainType {
  return [
    'helper.hello',
    'helper.status',
    'permission.status',
    'capture.result',
    'capture.skipped',
    'capture.error',
    'helper.heartbeat',
    'helper.exiting',
  ].includes(type);
}
