import { describe, expect, it } from 'bun:test';
import type {
  HelperEnvelope,
  HelperToMainPayloadByType,
  MainToHelperType,
} from '../../helper/index';
import {
  HELPER_PROTOCOL_VERSION,
  decodeHelperEnvelopeLine,
  validateHelperToMainEnvelope,
} from '../../helper/index';
import { createMemoryStore } from '../../storage';
import {
  type CaptureHelperCommandClient,
  createCaptureHelperEventHandler,
} from '../helper-event-handler';

const observedAt = '2026-07-07T08:00:00.000Z';
const workspaceId = 'workspace_1';
const deviceId = 'device_1';
describe('capture helper event handler', () => {
  it('does not publish capture.skipped into the control observation channel', async () => {
    const store = createMemoryStore();
    const client = new RecordingCaptureHelperCommandClient(store, 'capture_1');
    const handler = createCaptureHelperEventHandler({
      client,
      deviceId,
      now: () => observedAt,
      store,
      workspaceId,
    });
    const observations: unknown[] = [];
    handler.subscribeToObservation((observation) => {
      observations.push(observation);
    });

    await handler.handleProtocolResult(
      decodeHelperEnvelopeLine(
        JSON.stringify({
          correlationId: null,
          messageId: 'message_low_information',
          payload: {
            captureId: 'capture_low_information',
            observedAt,
            reason: 'low_information',
          },
          protocolVersion: HELPER_PROTOCOL_VERSION,
          sentAt: observedAt,
          type: 'capture.skipped',
        }),
        validateHelperToMainEnvelope,
      ),
    );

    expect(observations).toEqual([]);
    expect(client.commands).toEqual([]);
  });

  it('acks capture.result only after asset refs and outbox jobs are durably recorded', async () => {
    const store = createMemoryStore();
    const client = new RecordingCaptureHelperCommandClient(store, 'capture_1');
    const handler = createCaptureHelperEventHandler({
      client,
      deviceId,
      now: () => observedAt,
      store,
      workspaceId,
    });
    await handler.handleEnvelope(captureResultEnvelope());

    expect(client.commandTypes()).toEqual(['capture.ack']);
    expect(client.storeStateAtFirstCommand).toEqual({
      assetRecorded: true,
      jobRecorded: true,
      jobState: 'pending',
    });
    expect(await store.getAssetCacheRef('asset_capture_1')).toMatchObject({
      assetRefId: 'asset_capture_1',
      cleanupState: 'retained',
      hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      localAccessKey: 'asset_capture_1',
      role: 'capture_original',
      workspaceId,
    });
    expect(await store.getOutboxJob('capture_1')).toMatchObject({
      assetRefId: 'asset_capture_1',
      deviceId,
      id: 'capture_1',
      idempotencyKey: 'workspace_1:capture_1',
      state: 'pending',
      capture: {
        appName: 'Safari',
        bundleId: 'com.apple.Safari',
        capturedAt: observedAt,
        localEventId: 'capture_1',
        observedAt,
        privacyDecision: {
          action: 'redact_context',
          policyVersion: 'policy_1',
          reasons: ['redact_context'],
        },
        urlCandidate: {
          kind: 'redacted',
          reason: 'policy_redacted',
        },
        windowTitleCandidate: {
          kind: 'redacted',
          reason: 'policy_redacted',
        },
      },
    });
    expect((await store.getOutboxJob('capture_1'))?.serverCaptureId).toBeUndefined();
  });

  it('does not classify an ACK transport failure as a storage failure', async () => {
    const store = createMemoryStore();
    const commands: MainToHelperType[] = [];
    const observations: string[] = [];
    const handler = createCaptureHelperEventHandler({
      client: {
        async sendCommand(command) {
          commands.push(command.type);
          if (command.type === 'capture.ack') {
            throw new Error('helper transport closed');
          }
        },
      },
      deviceId,
      now: () => observedAt,
      store,
      workspaceId,
    });
    handler.subscribeToObservation((observation) => {
      observations.push(
        observation.type === 'storage_failure'
          ? `${observation.type}:${observation.target}`
          : observation.type,
      );
    });

    await handler.handleEnvelope(captureResultEnvelope());

    expect(await store.getOutboxJob('capture_1')).not.toBeNull();
    expect(commands).toEqual(['capture.ack']);
    expect(observations).toEqual(['capture_result', 'capture_error']);
  });

  it('lets atomic intake enforce the hard queue limit for concurrent results', async () => {
    const store = createMemoryStore({ maxActiveOutboxJobs: 1 });
    const client = new RecordingCaptureHelperCommandClient(store, 'capture_1');
    const handler = createCaptureHelperEventHandler({
      client,
      deviceId,
      now: () => observedAt,
      store,
      workspaceId,
    });

    await Promise.all([
      handler.handleEnvelope(captureResultEnvelopeFor('capture_1')),
      handler.handleEnvelope(captureResultEnvelopeFor('capture_2')),
    ]);

    const jobs = await store.listOutboxJobs({ workspaceId });
    expect(jobs).toHaveLength(1);
    expect(client.commandTypes().filter((type) => type === 'capture.ack')).toHaveLength(1);
    expect(client.commands.filter((command) => command.type === 'capture.nack')).toMatchObject([
      { payload: { code: 'backpressure' } },
    ]);
  });

  it('lets atomic intake decide capacity without issuing lifecycle commands', async () => {
    const store = createMemoryStore({ maxActiveOutboxJobs: 0 });
    const createCaptureOutboxEntry = store.createCaptureOutboxEntry.bind(store);
    let intakeAttempts = 0;
    store.createCaptureOutboxEntry = async (entry) => {
      intakeAttempts += 1;
      return createCaptureOutboxEntry(entry);
    };
    const client = new RecordingCaptureHelperCommandClient(store, 'capture_1');
    const handler = createCaptureHelperEventHandler({
      client,
      deviceId,
      now: () => observedAt,
      store,
      workspaceId,
    });
    await handler.handleEnvelope(captureResultEnvelope());

    expect(intakeAttempts).toBe(1);
    expect(client.commandTypes()).toEqual(['capture.nack']);
    expect(client.commands[0]).toMatchObject({
      type: 'capture.nack',
      payload: {
        captureId: 'capture_1',
        code: 'backpressure',
      },
    });
    expect(await store.getAssetCacheRef('asset_capture_1')).toBeNull();
    expect(await store.getOutboxJob('capture_1')).toBeNull();
  });

  it('nacks storage failures with a safe typed error and without leaking sensitive details', async () => {
    const store = createThrowingStore(
      createMemoryStore(),
      new Error(
        'sqlite failed for /Users/alice/Pictures/private.png with token secret and OCR raw text from stderr',
      ),
    );
    const client = new RecordingCaptureHelperCommandClient(store, 'capture_1');
    let storageFailures = 0;
    const handler = createCaptureHelperEventHandler({
      client,
      deviceId,
      now: () => observedAt,
      store,
      workspaceId,
    });
    handler.subscribeToObservation((observation) => {
      if (observation.type === 'storage_failure' && observation.target === 'intake') {
        storageFailures += 1;
      }
    });

    await handler.handleEnvelope(captureResultEnvelope());

    expect(client.commandTypes()).toEqual(['capture.nack']);
    expect(client.commands[0]).toMatchObject({
      type: 'capture.nack',
      payload: {
        captureId: 'capture_1',
        code: 'storage_unavailable',
        message: 'Capture could not be queued locally.',
      },
    });
    const serialized = JSON.stringify(client.commands);
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('OCR raw text');
    expect(serialized).not.toContain('stderr');
    expect(storageFailures).toBe(1);
  });

  it('promotes a typed storage corruption result into admission storage failure', async () => {
    const store = createMemoryStore();
    store.createCaptureOutboxEntry = async () => ({
      error: { code: 'storage_corruption', message: 'Operational storage is corrupt.' },
      ok: false,
    });
    const client = new RecordingCaptureHelperCommandClient(store, 'capture_1');
    let storageFailures = 0;
    const handler = createCaptureHelperEventHandler({
      client,
      deviceId,
      now: () => observedAt,
      store,
      workspaceId,
    });
    handler.subscribeToObservation((observation) => {
      if (observation.type === 'storage_failure' && observation.target === 'intake') {
        storageFailures += 1;
      }
    });

    await handler.handleEnvelope(captureResultEnvelope());

    expect(storageFailures).toBe(1);
    expect(client.commands).toMatchObject([{ payload: { code: 'storage_unavailable' } }]);
  });

  it('does not leave asset refs behind when outbox entry creation fails', async () => {
    const store = createMemoryStore({ maxActiveOutboxJobs: 0 });
    const client = new RecordingCaptureHelperCommandClient(store, 'capture_1');
    const handler = createCaptureHelperEventHandler({
      client,
      deviceId,
      now: () => observedAt,
      store,
      workspaceId,
    });

    await handler.handleEnvelope(captureResultEnvelope());

    expect(client.commandTypes()).toEqual(['capture.nack']);
    expect(client.commands[0]).toMatchObject({
      payload: {
        captureId: 'capture_1',
        code: 'backpressure',
      },
      type: 'capture.nack',
    });
    expect(await store.getAssetCacheRef('asset_capture_1')).toBeNull();
    expect(await store.getOutboxJob('capture_1')).toBeNull();
  });

  it('acks repeated identical capture.result without rewriting the existing entry', async () => {
    const store = createMemoryStore();
    const client = new RecordingCaptureHelperCommandClient(store, 'capture_1');
    const handler = createCaptureHelperEventHandler({
      client,
      deviceId,
      now: () => observedAt,
      store,
      workspaceId,
    });

    await handler.handleEnvelope(captureResultEnvelope());
    await handler.handleEnvelope(captureResultEnvelope());

    expect(client.commandTypes()).toEqual(['capture.ack', 'capture.ack']);
    expect(await store.listOutboxJobs({ workspaceId })).toHaveLength(1);
    expect(await store.getAssetCacheRef('asset_capture_1')).toMatchObject({
      hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sizeBytes: 4096,
    });
  });

  it('nacks divergent idempotency conflicts without overwriting existing asset refs', async () => {
    const store = createMemoryStore();
    const client = new RecordingCaptureHelperCommandClient(store, 'capture_1');
    const handler = createCaptureHelperEventHandler({
      client,
      deviceId,
      now: () => observedAt,
      store,
      workspaceId,
    });

    await handler.handleEnvelope(captureResultEnvelope());
    await handler.handleEnvelope(
      captureResultEnvelope({
        assets: [
          {
            hash: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
            mimeType: 'image/png',
            ref: 'asset_capture_1',
            role: 'screenshot',
            sizeBytes: 8192,
          },
        ],
      }),
    );

    expect(client.commandTypes()).toEqual(['capture.ack', 'capture.nack']);
    expect(client.commands[1]).toMatchObject({
      payload: {
        captureId: 'capture_1',
        code: 'conflict',
        message: 'Capture delivery conflicts with an existing local record.',
      },
      type: 'capture.nack',
    });
    expect(await store.getAssetCacheRef('asset_capture_1')).toMatchObject({
      hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sizeBytes: 4096,
    });
    expect(await store.listOutboxJobs({ workspaceId })).toHaveLength(1);
  });

  it('sends typed nacks for protocol errors without leaking raw payload content', async () => {
    const store = createMemoryStore();
    const client = new RecordingCaptureHelperCommandClient(store, 'capture_1');
    const handler = createCaptureHelperEventHandler({
      client,
      deviceId,
      now: () => observedAt,
      store,
      workspaceId,
    });

    await handler.handleProtocolResult(
      decodeHelperEnvelopeLine(
        '{"protocolVersion":"recapsy.capture-helper","messageId":"msg_bad","type":"capture.result","payload":{"providerToken":"secret-token","path":"/Users/alice/private.png","ocr":"OCR raw text"',
        validateHelperToMainEnvelope,
      ),
    );
    await handler.handleProtocolResult(
      decodeHelperEnvelopeLine(
        JSON.stringify({
          correlationId: null,
          messageId: 'msg_schema',
          payload: {
            captureId: 'capture_schema',
            localPath: '/Users/alice/Pictures/private.png',
            ocrText: 'OCR raw text from a private window',
            providerToken: 'secret-token',
          },
          protocolVersion: HELPER_PROTOCOL_VERSION,
          sentAt: observedAt,
          type: 'capture.result',
        }),
        validateHelperToMainEnvelope,
      ),
    );
    await handler.handleProtocolResult(
      decodeHelperEnvelopeLine(
        JSON.stringify({
          correlationId: null,
          messageId: 'msg_unknown',
          payload: {
            captureId: 'capture_unknown',
            localPath: '/Users/alice/Pictures/private.png',
            token: 'secret-token',
          },
          protocolVersion: HELPER_PROTOCOL_VERSION,
          sentAt: observedAt,
          type: 'capture.raw_debug',
        }),
        validateHelperToMainEnvelope,
      ),
    );

    expect(client.commandTypes()).toEqual(['capture.nack', 'capture.nack', 'capture.nack']);
    expect(client.commands).toMatchObject([
      {
        correlationId: null,
        payload: {
          code: 'schema_mismatch',
          message: 'Capture helper message could not be accepted.',
        },
      },
      {
        correlationId: 'msg_schema',
        payload: {
          captureId: 'capture_schema',
          code: 'schema_mismatch',
          message: 'Capture helper message could not be accepted.',
        },
      },
      {
        correlationId: 'msg_unknown',
        payload: {
          code: 'schema_mismatch',
          message: 'Capture helper message could not be accepted.',
        },
      },
    ]);
    const serialized = JSON.stringify(client.commands);
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('OCR raw text');
    expect(serialized).not.toContain('capture.raw_debug');
  });

  it('publishes typed capture errors without helper-provided text', async () => {
    const store = createMemoryStore();
    const client = new RecordingCaptureHelperCommandClient(store, 'capture_1');
    let storageWriteFailures = 0;
    const observations: unknown[] = [];
    const handler = createCaptureHelperEventHandler({
      client,
      deviceId,
      now: () => observedAt,
      store,
      workspaceId,
    });
    handler.subscribeToObservation((observation) => {
      observations.push(observation);
      if (observation.type === 'storage_failure' && observation.target === 'asset') {
        storageWriteFailures += 1;
      }
    });
    await handler.handleEnvelope(
      helperEnvelope('capture.error', {
        captureId: 'capture_error',
        code: 'asset_write_failed',
        message:
          'stderr wrote /Users/alice/private.png containing OCR raw text from Quarterly Planning',
      }),
    );

    expect(observations).toContainEqual({
      code: 'asset_write_failed',
      observedAt,
      type: 'capture_error',
    });
    const serialized = JSON.stringify(observations);
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('stderr');
    expect(serialized).not.toContain('OCR raw text');
    expect(serialized).not.toContain('Quarterly Planning');
  });

  it('publishes capture failures and durable results as control facts', async () => {
    const store = createMemoryStore();
    const client = new RecordingCaptureHelperCommandClient(store, 'capture_1');
    const handler = createCaptureHelperEventHandler({
      client,
      deviceId,
      now: () => observedAt,
      store,
      workspaceId,
    });
    const observations: string[] = [];
    handler.subscribeToObservation((observation) => {
      observations.push(observation.type);
    });

    await handler.handleEnvelope(
      helperEnvelope('capture.error', {
        captureId: 'capture_error_1',
        code: 'capture_failed',
        message: 'first failure',
      }),
    );
    await handler.handleEnvelope(
      helperEnvelope('capture.error', {
        captureId: 'capture_error_2',
        code: 'capture_failed',
        message: 'second failure',
      }),
    );

    await handler.handleEnvelope(captureResultEnvelope());

    expect(observations).toEqual(['capture_error', 'capture_error', 'capture_result']);
  });

  it('publishes the helper exit reason without changing accepted work', async () => {
    const store = createMemoryStore();
    await store.createOutboxJob({
      assetRefId: 'asset_existing',
      createdAt: observedAt,
      deviceId,
      id: 'job_existing',
      idempotencyKey: 'idem_existing',
      payloadHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      workspaceId,
    });
    const client = new RecordingCaptureHelperCommandClient(store, 'capture_1');
    const handler = createCaptureHelperEventHandler({
      client,
      deviceId,
      now: () => observedAt,
      store,
      workspaceId,
    });
    const observations: unknown[] = [];
    handler.subscribeToObservation((observation) => {
      observations.push(observation);
    });

    await handler.handleEnvelope(helperExitingEnvelope());

    expect(client.commands).toEqual([]);
    expect(await store.getOutboxJob('job_existing')).toMatchObject({
      id: 'job_existing',
      state: 'pending',
    });
    expect(observations).toContainEqual({
      observedAt,
      reason: 'process_crashed',
      type: 'helper_exit',
    });
  });

  it('publishes permission and capture errors as control facts', async () => {
    const store = createMemoryStore();
    const client = new RecordingCaptureHelperCommandClient(store, 'capture_1');
    const handler = createCaptureHelperEventHandler({
      client,
      deviceId,
      now: () => observedAt,
      store,
      workspaceId,
    });
    let storageWriteFailures = 0;
    const observations: unknown[] = [];
    handler.subscribeToObservation((observation) => {
      observations.push(observation);
      if (observation.type === 'storage_failure' && observation.target === 'asset') {
        storageWriteFailures += 1;
      }
    });

    await handler.handleEnvelope(
      helperEnvelope('permission.status', {
        accessibility: 'granted',
        observedAt,
        screenCapture: 'granted',
      }),
    );

    await handler.handleEnvelope(
      helperEnvelope('capture.error', {
        captureId: 'capture_error',
        code: 'asset_write_failed',
        message: 'disk full',
      }),
    );

    expect(observations).toContainEqual({
      observedAt,
      permissions: {
        accessibility: 'granted',
        screenRecording: 'granted',
      },
      type: 'permission',
    });
    expect(observations).toContainEqual({
      code: 'asset_write_failed',
      observedAt,
      type: 'capture_error',
    });
    expect(storageWriteFailures).toBe(1);
  });

  it('publishes permission observations only for permission.status events', async () => {
    const store = createMemoryStore();
    const client = new RecordingCaptureHelperCommandClient(store, 'capture_1');
    const handler = createCaptureHelperEventHandler({
      client,
      deviceId,
      now: () => observedAt,
      store,
      workspaceId,
    });
    const observations: string[] = [];
    handler.subscribeToObservation((observation) => {
      observations.push(observation.type);
    });

    await handler.handleEnvelope(
      helperEnvelope('permission.status', {
        accessibility: 'not_determined',
        observedAt,
        screenCapture: 'denied',
      }),
    );

    await handler.handleEnvelope(
      helperEnvelope('helper.heartbeat', {
        sequence: 1,
        status: 'ready',
      }),
    );

    await handler.handleEnvelope(
      helperEnvelope('permission.status', {
        accessibility: 'granted',
        observedAt,
        screenCapture: 'granted',
      }),
    );
    expect(observations).toEqual(['permission', 'heartbeat', 'permission']);
  });

  it('stops publishing observations after unsubscribe', async () => {
    const store = createMemoryStore();
    const client = new RecordingCaptureHelperCommandClient(store, 'capture_1');
    const handler = createCaptureHelperEventHandler({
      client,
      deviceId,
      now: () => observedAt,
      store,
      workspaceId,
    });
    const observations: string[] = [];
    const unsubscribe = handler.subscribeToObservation((observation) => {
      observations.push(observation.type);
    });

    await handler.handleEnvelope(
      helperEnvelope('helper.heartbeat', {
        sequence: 1,
        status: 'ready',
      }),
    );
    await handler.handleEnvelope(
      helperEnvelope('permission.status', {
        accessibility: 'granted',
        observedAt,
        screenCapture: 'denied',
      }),
    );

    unsubscribe();
    await handler.handleEnvelope(
      helperEnvelope('permission.status', {
        accessibility: 'granted',
        observedAt,
        screenCapture: 'granted',
      }),
    );

    expect(observations).toEqual(['heartbeat', 'permission']);
  });

  it('propagates observation delivery failures instead of hiding them', async () => {
    const store = createMemoryStore();
    const client = new RecordingCaptureHelperCommandClient(store, 'capture_1');
    const handler = createCaptureHelperEventHandler({
      client,
      deviceId,
      now: () => observedAt,
      store,
      workspaceId,
    });
    handler.subscribeToObservation(() => {
      throw new Error('control owner unavailable');
    });

    await expect(
      handler.handleEnvelope(helperEnvelope('helper.heartbeat', { sequence: 1, status: 'ready' })),
    ).rejects.toThrow('Capture control observation could not be delivered.');
  });
});

class RecordingCaptureHelperCommandClient
  implements Pick<CaptureHelperCommandClient, 'sendCommand'>
{
  readonly commands: HelperEnvelope<MainToHelperType>[] = [];
  storeStateAtFirstCommand:
    | {
        assetRecorded: boolean;
        jobRecorded: boolean;
        jobState?: string;
      }
    | undefined;

  constructor(
    private readonly store: Pick<
      ReturnType<typeof createMemoryStore>,
      'getAssetCacheRef' | 'getOutboxJob'
    >,
    private readonly captureId: string,
  ) {}

  async sendCommand(command: HelperEnvelope<MainToHelperType>): Promise<void> {
    if (!this.storeStateAtFirstCommand) {
      const asset = await this.store.getAssetCacheRef(`asset_${this.captureId}`);
      const job = await this.store.getOutboxJob(this.captureId);
      this.storeStateAtFirstCommand = {
        assetRecorded: Boolean(asset),
        jobRecorded: Boolean(job),
        ...(job ? { jobState: job.state } : {}),
      };
    }

    this.commands.push(command);
  }

  commandTypes(): MainToHelperType[] {
    return this.commands.map((command) => command.type);
  }
}

function captureResultEnvelope(
  overrides: Partial<HelperToMainPayloadByType['capture.result']> = {},
): HelperEnvelope<'capture.result'> {
  return helperEnvelope('capture.result', {
    assets: [
      {
        hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        mimeType: 'image/png',
        ref: 'asset_capture_1',
        role: 'screenshot',
        sizeBytes: 4096,
      },
    ],
    captureId: 'capture_1',
    context: {
      app: {
        bundleId: 'com.apple.Safari',
        name: 'Safari',
      },
      observedAt,
      policy: {
        decision: 'redact_context',
        version: 'policy_1',
      },
      website: {
        host: 'example.test',
        origin: 'https://example.test',
      },
      window: {
        title: 'Planning',
      },
    },
    observedAt,
    ...overrides,
  });
}

function captureResultEnvelopeFor(captureId: string): HelperEnvelope<'capture.result'> {
  const base = captureResultEnvelope();
  return helperEnvelope('capture.result', {
    ...base.payload,
    assets: [
      {
        ...base.payload.assets[0],
        ref: base.payload.assets[0].ref.replace('capture_1', captureId),
      },
    ],
    captureId,
  });
}

function helperExitingEnvelope(): HelperEnvelope<'helper.exiting'> {
  return helperEnvelope('helper.exiting', {
    code: 1,
    reason: 'process_crashed',
  });
}

function helperEnvelope<TType extends keyof HelperToMainPayloadByType>(
  type: TType,
  payload: HelperToMainPayloadByType[TType],
): HelperEnvelope<TType> {
  return {
    correlationId: 'correlation_1',
    messageId: `message_${type}`,
    payload,
    protocolVersion: HELPER_PROTOCOL_VERSION,
    sentAt: observedAt,
    type,
  } as HelperEnvelope<TType>;
}

function createThrowingStore(
  store: ReturnType<typeof createMemoryStore>,
  error: Error,
): ReturnType<typeof createMemoryStore> {
  const failingStore = Object.create(store) as ReturnType<typeof createMemoryStore>;
  failingStore.upsertAssetCacheRef = async () => {
    throw error;
  };
  failingStore.createCaptureOutboxEntry = async () => {
    throw error;
  };

  return failingStore;
}
