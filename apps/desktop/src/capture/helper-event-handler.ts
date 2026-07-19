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
import type { CaptureHelperObservation } from './control';
import { projectCaptureOutboxEntry } from './outbox-entry';
import type { CaptureIntakeStore } from './store';

export type { CaptureHelperCommandClient } from '../helper/index';

export type CaptureHelperEventHandler = {
  handleEnvelope(envelope: HelperEnvelope<HelperToMainType>): Promise<void>;
  handleProtocolResult(result: HelperProtocolResult<HelperEnvelope>): Promise<void>;
  subscribeToObservation(
    listener: (observation: CaptureHandlerObservation) => Promise<void> | void,
  ): () => void;
};

export type CaptureHandlerObservation =
  | CaptureHelperObservation
  | {
      target: 'asset' | 'intake';
      type: 'storage_failure';
    };

export type CaptureHelperEventHandlerOptions = {
  client: Pick<CaptureHelperCommandClient, 'sendCommand'>;
  deviceId: string;
  now(): string;
  store: CaptureIntakeStore;
  workspaceId: string;
};

type CaptureNackCode = MainToHelperPayloadByType['capture.nack']['code'];

class CaptureObservationDeliveryError extends Error {
  constructor() {
    super('Capture control observation could not be delivered.');
  }
}

export function createCaptureHelperEventHandler(
  options: CaptureHelperEventHandlerOptions,
): CaptureHelperEventHandler {
  return new StoreBackedCaptureHelperEventHandler(options);
}

class StoreBackedCaptureHelperEventHandler implements CaptureHelperEventHandler {
  private messageSequence = 0;
  private readonly observationListeners = new Set<
    (observation: CaptureHandlerObservation) => Promise<void> | void
  >();

  constructor(private readonly options: CaptureHelperEventHandlerOptions) {}

  subscribeToObservation(
    listener: (observation: CaptureHandlerObservation) => Promise<void> | void,
  ): () => void {
    this.observationListeners.add(listener);
    return () => {
      this.observationListeners.delete(listener);
    };
  }

  async handleEnvelope(envelope: HelperEnvelope<HelperToMainType>): Promise<void> {
    try {
      switch (envelope.type) {
        case 'capture.result':
          await this.handleCaptureResult(narrowHelperEnvelope(envelope, 'capture.result'));
          return;
        case 'capture.skipped':
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
          await this.notifyObservation({ observedAt: envelope.sentAt, type: 'heartbeat' });
          return;
      }
    } catch (error) {
      if (error instanceof CaptureObservationDeliveryError) throw error;
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
    const entry = projectCaptureOutboxEntry({
      deviceId: this.options.deviceId,
      payload: envelope.payload,
      workspaceId: this.options.workspaceId,
    });

    let result: Awaited<ReturnType<CaptureIntakeStore['createCaptureOutboxEntry']>>;
    try {
      result = await this.options.store.createCaptureOutboxEntry(entry);
    } catch {
      await this.notifyObservation({ target: 'intake', type: 'storage_failure' });
      await this.notifyObservation({
        code: 'storage_unavailable',
        observedAt: envelope.sentAt,
        type: 'capture_error',
      });
      await this.sendNack(envelope, 'storage_unavailable', safeNackMessage('storage_unavailable'));
      return;
    }

    if (!result.ok) {
      if (result.error.code === 'storage_corruption') {
        await this.notifyObservation({ target: 'intake', type: 'storage_failure' });
      }
      await this.notifyObservation({
        code: result.error.code,
        observedAt: envelope.sentAt,
        type: 'capture_error',
      });
      await this.sendNack(
        envelope,
        mapStoreErrorToNackCode(result.error.code),
        safeNackMessage(result.error.code),
      );
      return;
    }

    await this.notifyObservation({ observedAt: envelope.sentAt, type: 'capture_result' });
    try {
      await this.sendCommand(envelope, 'capture.ack', {
        captureId,
      });
    } catch {
      await this.notifyObservation({
        code: 'helper_unavailable',
        observedAt: envelope.sentAt,
        type: 'capture_error',
      });
    }
  }

  private async recordCaptureError(envelope: HelperEnvelope<'capture.error'>): Promise<void> {
    await this.notifyObservation({
      code: envelope.payload.code,
      observedAt: envelope.sentAt,
      type: 'capture_error',
    });
    if (envelope.payload.code === 'asset_write_failed') {
      await this.notifyObservation({ target: 'asset', type: 'storage_failure' });
    }
  }

  private async recordHelperExit(envelope: HelperEnvelope<'helper.exiting'>): Promise<void> {
    await this.notifyObservation({
      observedAt: envelope.sentAt,
      reason: envelope.payload.reason,
      type: 'helper_exit',
    });
  }

  private async recordPermissionStatus(
    envelope: HelperEnvelope<'permission.status'>,
  ): Promise<void> {
    await this.notifyObservation({
      observedAt: envelope.sentAt,
      permissions: {
        accessibility: envelope.payload.accessibility,
        screenRecording: envelope.payload.screenCapture,
      },
      type: 'permission',
    });
  }

  private async notifyObservation(observation: CaptureHandlerObservation): Promise<void> {
    try {
      await Promise.all([...this.observationListeners].map((listener) => listener(observation)));
    } catch {
      throw new CaptureObservationDeliveryError();
    }
  }

  private async recordUnexpectedEventFailure(envelope: HelperEnvelope): Promise<void> {
    await this.notifyObservation({ observedAt: envelope.sentAt, type: 'protocol_error' });

    if (isCaptureEnvelope(envelope)) {
      await this.sendNack(envelope, 'unknown', 'Capture event could not be accepted.');
    }
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
