import { describe, expect, it } from 'bun:test';
import {
  HELPER_PROTOCOL_VERSION,
  type HelperEnvelope,
  type MainToHelperType,
} from '../helper/public';
import { type BackpressureConfig, createMemoryStore } from '../storage';
import {
  type CaptureHelperClient,
  type CaptureHelperEvent,
  type CaptureHelperStartOptions,
  createCaptureHelperController,
} from './helper-controller';
import { createCaptureHelperEventHandler } from './helper-event-handler';
import type { HelperStateStore } from './store';

const now = '2026-07-07T08:00:00.000Z';
const backpressure: BackpressureConfig = {
  maxAssetBytes: 1024 * 1024,
  maxQueuedJobs: 10,
  maxRetryAttempts: 5,
};

describe('capture helper controller', () => {
  it('starts the helper through explicit dependency injection and records running state', async () => {
    const client = new RecordingCaptureHelperClient();
    const store = createMemoryStore();
    const controller = createCaptureHelperController({
      client,
      deviceId: 'device_1',
      now: () => now,
      store,
    });

    await controller.start();

    expect(client.calls).toEqual(['start', 'beginCapture']);
    expect(client.beginCaptureReasons).toEqual(['runtime_started']);
    expect(controller.getStatus()).toMatchObject({
      state: 'running',
    });
    expect(await store.getHelperState()).toMatchObject({
      connectionKind: 'managed_helper',
      restartCount: 0,
      updatedAt: now,
    });
  });

  it('fails closed on helper start failure without entering running state', async () => {
    const store = createMemoryStore();
    const client = new RecordingCaptureHelperClient({
      startError: new Error(
        'spawn failed for /Users/alice/Library/Recapsy/helper with token secret and OCR raw text',
      ),
    });
    const controller = createCaptureHelperController({
      client,
      deviceId: 'device_1',
      now: () => now,
      store,
    });

    await expect(controller.start()).rejects.toThrow('helper_start_failed');

    expect(client.calls).toEqual(['start']);
    expect(client.beginCaptureReasons).toEqual([]);
    expect(controller.getStatus()).toMatchObject({
      state: 'failed',
      lastSafeError: {
        code: 'helper_start_failed',
        retryable: true,
      },
    });
    const serialized = JSON.stringify(controller.getStatus());
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('OCR raw text');
  });

  it('observes unexpected helper exit without deleting or resetting outbox jobs', async () => {
    const store = createMemoryStore();
    await store.createOutboxJob({
      assetRefId: 'asset_existing',
      createdAt: now,
      deviceId: 'device_1',
      id: 'job_existing',
      idempotencyKey: 'idem_existing',
      payloadHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      workspaceId: 'workspace_1',
    });
    const client = new RecordingCaptureHelperClient();
    const controller = createCaptureHelperController({
      client,
      deviceId: 'device_1',
      now: () => now,
      store,
    });
    await controller.start();

    await controller.handleEvent({
      code: 1,
      error: 'stderr /private/tmp/helper.log token secret OCR raw text',
      reason: 'process_crashed',
      type: 'unexpectedExit',
    });

    expect(controller.getStatus()).toMatchObject({
      state: 'exited',
      lastSafeError: {
        code: 'helper_unexpected_exit',
      },
    });
    expect(await store.getOutboxJob('job_existing')).toMatchObject({
      id: 'job_existing',
      state: 'pending',
    });
    expect(await store.listOutboxJobs({ workspaceId: 'workspace_1' })).toHaveLength(1);
    expect(JSON.stringify(controller.getStatus())).not.toContain('/private/tmp');
    expect(JSON.stringify(controller.getStatus())).not.toContain('secret');
    expect(JSON.stringify(controller.getStatus())).not.toContain('OCR raw text');
  });

  it('routes internal capture events through the envelope handler without a second outbox path', async () => {
    const store = createMemoryStore();
    const commandClient = new RecordingCommandClient();
    const client = new RecordingCaptureHelperClient();
    const controller = createCaptureHelperController({
      client,
      deviceId: 'device_1',
      eventHandler: createCaptureHelperEventHandler({
        backpressure,
        client: commandClient,
        deviceId: 'device_1',
        now: () => now,
        store,
        workspaceId: 'workspace_1',
      }),
      now: () => now,
      store,
    });
    await controller.start();

    await controller.handleEvent(
      createCaptureEvent({
        metadata: {
          note: 'safe metadata',
          manifestPath: '/Users/alice/private/manifest.json',
          providerToken: 'provider-secret',
          ocrPayload: 'OCR raw text',
        },
      }),
    );

    const asset = await store.getAssetCacheRef('asset_capture_1');
    const jobs = await store.listOutboxJobs({ workspaceId: 'workspace_1' });

    expect(commandClient.commandTypes()).toEqual(['capture.ack']);
    expect(asset).toMatchObject({
      assetRefId: 'asset_capture_1',
      availabilityState: 'available',
      cleanupState: 'retained',
      hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      localAccessKey: 'asset_capture_1',
      role: 'capture_original',
      workspaceId: 'workspace_1',
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      assetRefId: 'asset_capture_1',
      deviceId: 'device_1',
      id: 'capture_1',
      idempotencyKey: 'workspace_1:capture_1',
      state: 'pending',
      capture: {
        appName: 'Safari',
        bundleId: 'com.apple.Safari',
        capturedAt: '2026-07-07T07:59:59.000Z',
        localEventId: 'capture_1',
        privacyDecision: {
          action: 'redact_context',
          decidedAt: '2026-07-07T07:59:59.000Z',
          policyVersion: 'policy_desktop',
          reasons: ['redact_context'],
        },
      },
    });

    const serialized = JSON.stringify({ asset, jobs });
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('provider-secret');
    expect(serialized).not.toContain('OCR raw text');
  });

  it('does not double-write helper_state when routing an unexpected exit through the event handler', async () => {
    const { store, setHelperStateCallCount } = createCountingHelperStateStore(createMemoryStore());
    const controller = createCaptureHelperController({
      client: new RecordingCaptureHelperClient(),
      deviceId: 'device_1',
      eventHandler: createCaptureHelperEventHandler({
        backpressure,
        client: new RecordingCommandClient(),
        deviceId: 'device_1',
        now: () => now,
        store,
        workspaceId: 'workspace_1',
      }),
      now: () => now,
      store,
    });
    await controller.start();
    const callsBeforeExit = setHelperStateCallCount();

    await controller.handleEvent({
      code: 1,
      reason: 'process_crashed',
      type: 'unexpectedExit',
    });

    expect(setHelperStateCallCount()).toBe(callsBeforeExit + 1);
    expect(controller.getStatus()).toMatchObject({
      lastSafeError: { code: 'helper_unexpected_exit' },
      state: 'exited',
    });
  });

  it('preserves event-handler-owned permissions when the controller persists its own status', async () => {
    const store = createMemoryStore();
    const eventHandler = createCaptureHelperEventHandler({
      backpressure,
      client: new RecordingCommandClient(),
      deviceId: 'device_1',
      now: () => now,
      store,
      workspaceId: 'workspace_1',
    });
    const controller = createCaptureHelperController({
      client: new RecordingCaptureHelperClient(),
      deviceId: 'device_1',
      eventHandler,
      now: () => now,
      store,
    });
    await controller.start();
    await eventHandler.handleEnvelope({
      correlationId: null,
      messageId: 'message_permission',
      payload: { accessibility: 'granted', observedAt: now, screenCapture: 'granted' },
      protocolVersion: HELPER_PROTOCOL_VERSION,
      sentAt: now,
      type: 'permission.status',
    });

    await controller.pauseCapture();

    expect(await store.getHelperState()).toMatchObject({
      permissions: { accessibility: 'granted', screenRecording: 'granted' },
    });
  });

  it('fails closed instead of mislabeling a legacy ocr_input asset as a screenshot', async () => {
    const store = createMemoryStore();
    const controller = createCaptureHelperController({
      client: new RecordingCaptureHelperClient(),
      deviceId: 'device_1',
      eventHandler: createCaptureHelperEventHandler({
        backpressure,
        client: new RecordingCommandClient(),
        deviceId: 'device_1',
        now: () => now,
        store,
        workspaceId: 'workspace_1',
      }),
      now: () => now,
      store,
    });
    await controller.start();

    await expect(
      controller.handleEvent(createCaptureEvent({ asset: { role: 'ocr_input' } })),
    ).rejects.toThrow('capture_helper_legacy_adapter_ocr_input_unsupported');
  });

  it('does not let internal capture events write outbox jobs when the handler is absent', async () => {
    const store = createMemoryStore();
    const controller = createCaptureHelperController({
      client: new RecordingCaptureHelperClient(),
      deviceId: 'device_1',
      now: () => now,
      store,
    });
    await controller.start();

    await controller.handleEvent(createCaptureEvent());

    expect(await store.getAssetCacheRef('asset_capture_1')).toBeNull();
    expect(await store.getOutboxJob('capture_1')).toBeNull();
    expect(controller.getStatus()).toMatchObject({
      lastSafeError: {
        code: 'capture_event_intake_required',
        retryable: false,
      },
      state: 'running',
    });
  });

  it('wires verified helper envelopes to the injected handler during start', async () => {
    const client = new RecordingCaptureHelperClient();
    const observed: HelperEnvelope[] = [];
    const controller = createCaptureHelperController({
      client,
      deviceId: 'device_1',
      eventHandler: {
        async handleEnvelope(envelope): Promise<void> {
          observed.push(envelope);
        },
      },
      now: () => now,
      store: createMemoryStore(),
    });

    await controller.start();
    await client.startOptions?.onEnvelope?.(helperStatusEnvelope());

    expect(observed).toEqual([helperStatusEnvelope()]);
  });

  it('stops the helper on shutdown and treats repeated stop as idempotent', async () => {
    const client = new RecordingCaptureHelperClient();
    const controller = createCaptureHelperController({
      client,
      deviceId: 'device_1',
      now: () => now,
      store: createMemoryStore(),
    });
    await controller.start();

    await controller.shutdown();
    await controller.shutdown();

    expect(client.calls).toEqual(['start', 'beginCapture', 'stop']);
    expect(controller.getStatus()).toMatchObject({
      state: 'stopped',
    });
  });
});

class RecordingCaptureHelperClient implements CaptureHelperClient {
  readonly calls: string[] = [];
  readonly beginCaptureReasons: Array<'runtime_started' | 'user_resumed'> = [];
  startOptions: CaptureHelperStartOptions | undefined;
  private readonly startError?: Error;

  constructor(options: { startError?: Error } = {}) {
    this.startError = options.startError;
  }

  async start(options?: CaptureHelperStartOptions): Promise<void> {
    this.calls.push('start');
    this.startOptions = options;

    if (this.startError) {
      throw this.startError;
    }
  }

  async beginCapture(reason: 'runtime_started' | 'user_resumed'): Promise<void> {
    this.calls.push('beginCapture');
    this.beginCaptureReasons.push(reason);
  }

  async stop(): Promise<void> {
    this.calls.push('stop');
  }

  async pauseCapture(): Promise<void> {
    this.calls.push('pauseCapture');
  }

  async resumeCapture(): Promise<void> {
    this.calls.push('resumeCapture');
  }
}

class RecordingCommandClient {
  readonly commands: HelperEnvelope<MainToHelperType>[] = [];

  async sendCommand(command: HelperEnvelope<MainToHelperType>): Promise<void> {
    this.commands.push(command);
  }

  commandTypes(): MainToHelperType[] {
    return this.commands.map((command) => command.type);
  }
}

function createCaptureEvent(
  overrides: Partial<Omit<CaptureObservedEvent, 'asset'>> & {
    asset?: Partial<CaptureHelperEventAsset>;
  } = {},
): CaptureHelperEvent {
  const { asset: assetOverrides, ...eventOverrides } = overrides;
  const captureId = overrides.captureId ?? 'capture_1';
  const asset = {
    assetRefId: `asset_${captureId}`,
    availabilityState: 'available' as const,
    contentAddress: `sha256/${captureId}`,
    hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    localAccessKey: '/Users/alice/Pictures/private.png',
    mimeType: 'image/png',
    role: 'capture_original' as const,
    sizeBytes: 4096,
    ...assetOverrides,
  };

  return {
    bundleId: 'com.apple.Safari',
    capturedAt: '2026-07-07T07:59:59.000Z',
    captureId,
    captureType: 'screen',
    contextConfidence: 'high',
    contextFingerprint: 'fingerprint_1',
    metadata: {},
    observedAt: '2026-07-07T07:59:59.000Z',
    privacyDecision: {
      action: 'redact_context',
      decidedAt: '2026-07-07T07:59:58.000Z',
      policyVersion: 'policy_desktop',
      reasons: ['domain_rule'],
    },
    sourceAppName: 'Safari',
    type: 'captureObserved',
    workspaceId: 'workspace_1',
    ...eventOverrides,
    asset,
  };
}

type CaptureObservedEvent = Extract<CaptureHelperEvent, { type: 'captureObserved' }>;

type CaptureHelperEventAsset = Extract<CaptureHelperEvent, { type: 'captureObserved' }>['asset'];

function createCountingHelperStateStore<TStore extends HelperStateStore>(
  store: TStore,
): {
  store: TStore;
  setHelperStateCallCount: () => number;
} {
  let count = 0;
  const wrapped = Object.create(store) as TStore;
  wrapped.setHelperState = async (state) => {
    count += 1;
    return store.setHelperState(state);
  };

  return { setHelperStateCallCount: () => count, store: wrapped };
}

function helperStatusEnvelope(): HelperEnvelope<'helper.status'> {
  return {
    correlationId: null,
    messageId: 'message_status',
    payload: {
      status: 'ready',
    },
    protocolVersion: HELPER_PROTOCOL_VERSION,
    sentAt: now,
    type: 'helper.status',
  };
}
