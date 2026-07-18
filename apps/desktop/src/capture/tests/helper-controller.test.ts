import { describe, expect, it } from 'bun:test';
import {
  HELPER_PROTOCOL_VERSION,
  type HelperCapturePolicy,
  type HelperEnvelope,
  type MainToHelperType,
} from '../../helper/index';
import { type BackpressureConfig, createMemoryStore } from '../../storage';
import {
  type CaptureHelperClient,
  type CaptureHelperEvent,
  type CaptureHelperStartOptions,
  createCaptureHelperController,
} from '../helper-controller';
import { createCaptureHelperEventHandler } from '../helper-event-handler';
import { type CaptureLifecycle, createCaptureLifecycle } from '../lifecycle';
import { type CapturePolicyActivation, CapturePolicyActivationError } from '../policy';
import type { HelperStateStore } from '../store';

const now = '2026-07-07T08:00:00.000Z';
const backpressure: BackpressureConfig = {
  maxAssetBytes: 1024 * 1024,
  maxQueuedJobs: 10,
  maxRetryingJobs: 5,
  resumeAssetBytes: 512 * 1024,
  resumeQueuedJobs: 5,
  resumeRetryingJobs: 2,
};

describe('capture helper controller', () => {
  it('retries a failed helper stop before executing a requested restart', async () => {
    const client = new FailingStopCaptureHelperClient(1);
    const { controller, lifecycle } = createActiveLifecycleHarness(client);
    await lifecycle.start();

    await expect(lifecycle.stop()).rejects.toThrow('helper stop failed');
    expect(controller.getStatus()).toMatchObject({ state: 'stopping' });
    expect(lifecycle.getSnapshot()).toMatchObject({ status: 'stopping' });

    await lifecycle.start();

    expect(client.calls).toEqual([
      'start',
      'configureCapture',
      'beginCapture',
      'stop',
      'stop',
      'start',
      'configureCapture',
      'beginCapture',
    ]);
    expect(controller.getStatus()).toMatchObject({ state: 'running' });
    expect(lifecycle.getSnapshot()).toMatchObject({ status: 'running' });
  });

  it('rejects restart when retrying a failed helper stop still fails', async () => {
    const client = new FailingStopCaptureHelperClient(2);
    const { controller, lifecycle } = createActiveLifecycleHarness(client);
    await lifecycle.start();

    await expect(lifecycle.stop()).rejects.toThrow('helper stop failed');
    await expect(lifecycle.start()).rejects.toThrow('helper stop failed');

    expect(client.calls).toEqual(['start', 'configureCapture', 'beginCapture', 'stop', 'stop']);
    expect(client.calls.filter((call) => call === 'start')).toHaveLength(1);
    expect(controller.getStatus()).toMatchObject({ state: 'stopping' });
    expect(lifecycle.getSnapshot()).toMatchObject({ status: 'stopping' });
  });

  it('waits for an in-flight stop before executing an explicit restart', async () => {
    const client = new PendingStopCaptureHelperClient();
    const { controller, lifecycle } = createActiveLifecycleHarness(client);
    await lifecycle.start();

    const stop = lifecycle.stop();
    while (!client.stopPending) await Promise.resolve();
    const restart = lifecycle.start();
    let restartSettled = false;
    void restart.then(() => {
      restartSettled = true;
    });
    await flush();

    expect(restartSettled).toBe(false);
    expect(client.calls).toEqual(['start', 'configureCapture', 'beginCapture', 'stop']);

    client.completeStop();
    await Promise.all([stop, restart]);

    expect(client.calls).toEqual([
      'start',
      'configureCapture',
      'beginCapture',
      'stop',
      'start',
      'configureCapture',
      'beginCapture',
    ]);
    expect(controller.getStatus()).toMatchObject({ state: 'running' });
    expect(lifecycle.getSnapshot()).toMatchObject({ status: 'running' });
  });

  it('shares one helper startup across concurrent lifecycle start calls', async () => {
    const client = new PendingStartCaptureHelperClient();
    const { controller, lifecycle } = createActiveLifecycleHarness(client);

    const firstStart = lifecycle.start();
    while (!client.startPending) await Promise.resolve();
    const secondStart = lifecycle.start();
    expect(secondStart).toBe(firstStart);
    await flush();
    const callsBeforeStartCompletes = [...client.calls];

    client.completeStart();
    await Promise.all([firstStart, secondStart]);

    expect(callsBeforeStartCompletes).toEqual(['start']);
    expect(client.calls).toEqual(['start', 'configureCapture', 'beginCapture']);
    expect(controller.getStatus()).toMatchObject({ state: 'running' });
    expect(lifecycle.getSnapshot()).toMatchObject({ status: 'running' });
  });

  it('shares one helper shutdown across concurrent lifecycle stop calls', async () => {
    const client = new PendingStopCaptureHelperClient();
    const { controller, lifecycle } = createActiveLifecycleHarness(client);
    await lifecycle.start();

    const firstStop = lifecycle.stop();
    while (!client.stopPending) await Promise.resolve();
    const secondStop = lifecycle.stop();
    expect(secondStop).toBe(firstStop);
    await flush();
    const callsBeforeStopCompletes = [...client.calls];

    client.completeStop();
    await Promise.all([firstStop, secondStop]);

    expect(callsBeforeStopCompletes).toEqual(['start', 'configureCapture', 'beginCapture', 'stop']);
    expect(client.calls.filter((call) => call === 'stop')).toHaveLength(1);
    expect(controller.getStatus()).toMatchObject({ state: 'stopped' });
    expect(lifecycle.getSnapshot()).toMatchObject({ status: 'stopped' });
  });

  it('stops immediately while lifecycle start is waiting for policy activation', async () => {
    const client = new RecordingCaptureHelperClient();
    const pending: Array<
      (configuration: Awaited<ReturnType<CapturePolicyActivation['activate']>>) => void
    > = [];
    const controller = createCaptureHelperController({
      client,
      deviceId: 'device_1',
      now: () => now,
      policyActivation: {
        async activate() {
          return await new Promise((resolve) => pending.push(resolve));
        },
      },
      store: createMemoryStore(),
    });
    const lifecycle = createCaptureLifecycle({ helper: controller });

    const start = lifecycle.start();
    while (pending.length < 1) await Promise.resolve();
    const stop = lifecycle.stop();
    let stopSettled = false;
    void stop.then(() => {
      stopSettled = true;
    });
    await flushUntil(() => stopSettled);

    expect(stopSettled).toBe(true);
    await Promise.all([start, stop]);
    expect(client.calls).toEqual(['start', 'stop']);
    expect(controller.getStatus()).toMatchObject({ state: 'stopped' });
    expect(lifecycle.getSnapshot()).toMatchObject({ status: 'stopped' });

    pending[0]?.(policyConfiguration('policy_stale', `sha256:${'e'.repeat(64)}`));
    await flush();
    expect(client.calls).toEqual(['start', 'stop']);
  });

  it('recovers from an unavailable policy without recursively awaiting helper resume', async () => {
    const harness = createPolicyRecoveryHarness();

    await harness.lifecycle.start();
    expect(harness.lifecycle.getSnapshot()).toMatchObject({
      pauseReasons: ['policy'],
      status: 'paused',
    });

    const refresh = harness.controller.refreshPolicy();
    let settled = false;
    void refresh.then(() => {
      settled = true;
    });
    await flushUntil(() => settled);

    expect(settled).toBe(true);
    await refresh;
    expect(harness.client.calls).toEqual(['start', 'configureCapture', 'beginCapture']);
    expect(harness.client.beginCaptureReasons).toEqual(['runtime_started']);
    expect(harness.client.configuredPolicyVersions).toEqual(['policy_recovered']);
    expect(harness.lifecycle.getSnapshot()).toMatchObject({
      captureHelper: { state: 'running', policyVersion: 'policy_recovered' },
      status: 'running',
    });
    expect(harness.lifecycle.getSnapshot().pauseReasons).toBeUndefined();
  });

  it('keeps recovery paused when permission, storage, or user causes remain active', async () => {
    for (const cause of ['permission', 'storage', 'user'] as const) {
      const harness = createPolicyRecoveryHarness([cause]);

      await harness.lifecycle.start();
      await harness.controller.refreshPolicy();

      expect(harness.client.calls).toEqual(['start', 'configureCapture']);
      expect(harness.client.beginCaptureReasons).toEqual([]);
      expect(harness.client.configuredPolicyVersions).toEqual(['policy_recovered']);
      expect(harness.lifecycle.getSnapshot()).toMatchObject({
        captureHelper: { state: 'paused', policyVersion: 'policy_recovered' },
        pauseReasons: [cause],
        status: 'paused',
      });
    }
  });

  it('does not let a pending helper resume restore running state after lifecycle stop', async () => {
    const client = new PendingResumeCaptureHelperClient();
    const lifecycleRef: { current?: CaptureLifecycle } = {};
    const controller = createCaptureHelperController({
      client,
      deviceId: 'device_1',
      now: () => now,
      onPolicyPauseChange: async (active) => {
        await lifecycleRef.current?.setPolicyPause(active);
      },
      policyActivation: activePolicyActivation(),
      store: createMemoryStore(),
    });
    const lifecycle = createCaptureLifecycle({ helper: controller });
    lifecycleRef.current = lifecycle;

    await lifecycle.start();
    await lifecycle.setAutomaticPause(true);
    const resume = lifecycle.setAutomaticPause(false);
    while (!client.resumePending) await Promise.resolve();

    const stop = lifecycle.stop();
    await stop;
    client.completeResume();
    await resume;

    expect(client.calls).toEqual([
      'start',
      'configureCapture',
      'beginCapture',
      'pauseCapture',
      'resumeCapture',
      'stop',
    ]);
    expect(controller.getStatus()).toMatchObject({ state: 'stopped' });
    expect(lifecycle.getSnapshot()).toMatchObject({ status: 'stopped' });
  });

  it('does not let a pending pause from an old lifecycle overwrite a restarted generation', async () => {
    const client = new PendingPauseCaptureHelperClient();
    const lifecycleRef: { current?: CaptureLifecycle } = {};
    const controller = createCaptureHelperController({
      client,
      deviceId: 'device_1',
      now: () => now,
      onPolicyPauseChange: async (active) => {
        await lifecycleRef.current?.setPolicyPause(active);
      },
      policyActivation: activePolicyActivation(),
      store: createMemoryStore(),
    });
    const lifecycle = createCaptureLifecycle({ helper: controller });
    lifecycleRef.current = lifecycle;

    await lifecycle.start();
    const pause = lifecycle.setAutomaticPause(true);
    while (!client.pausePending) await Promise.resolve();

    await lifecycle.stop();
    await lifecycle.start();
    client.completePause();
    await pause;

    expect(client.calls).toEqual([
      'start',
      'configureCapture',
      'beginCapture',
      'pauseCapture',
      'stop',
      'start',
      'configureCapture',
      'beginCapture',
    ]);
    expect(controller.getStatus()).toMatchObject({ state: 'running' });
    expect(lifecycle.getSnapshot()).toMatchObject({ status: 'running' });
    expect(lifecycle.getSnapshot().pauseReasons).toBeUndefined();
  });

  it('keeps the helper idle and creates no capture work when policy activation is unavailable', async () => {
    const store = createMemoryStore();
    const client = new RecordingCaptureHelperClient();
    const controller = createCaptureHelperController({
      client,
      deviceId: 'device_1',
      now: () => now,
      policyActivation: {
        async activate(): Promise<never> {
          throw new CapturePolicyActivationError('policy_unavailable');
        },
      },
      store,
    });

    await controller.start();

    expect(client.calls).toEqual(['start']);
    expect(client.beginCaptureReasons).toEqual([]);
    expect(await store.listOutboxJobs()).toEqual([]);
    expect(controller.getStatus()).toMatchObject({
      lastSafeError: {
        code: 'policy_unavailable',
        retryable: true,
      },
      state: 'paused',
    });
  });

  it('starts the helper through explicit dependency injection and records running state', async () => {
    const client = new RecordingCaptureHelperClient();
    const store = createMemoryStore();
    const controller = createCaptureHelperController({
      client,
      deviceId: 'device_1',
      now: () => now,
      policyActivation: activePolicyActivation(),
      store,
    });

    await controller.start();

    expect(client.calls).toEqual(['start', 'configureCapture', 'beginCapture']);
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

  it('refreshes the policy through a verified helper configuration and pauses when the policy changes to paused', async () => {
    const client = new RecordingCaptureHelperClient();
    const timers = new FakeTimers();
    const policyPauses: boolean[] = [];
    let activations = 0;
    const controller = createCaptureHelperController({
      clearTimeoutFn: timers.clear,
      client,
      deviceId: 'device_1',
      now: () => now,
      onPolicyPauseChange: async (active) => {
        policyPauses.push(active);
      },
      policyActivation: {
        async activate() {
          activations += 1;
          return {
            maxConcurrentOcr: 2,
            policy: {
              defaultAction: 'allow',
              paused: activations > 1,
              policyHash: `sha256:${String(activations).repeat(64)}`,
              rules: [],
              version: `policy_${activations}`,
            },
            refreshAfterMs: 60_000,
          };
        },
      },
      setTimeoutFn: timers.set,
      store: createMemoryStore(),
    });

    await controller.start();
    timers.fire();
    await flushUntil(() => controller.getStatus().policyVersion === 'policy_2');

    expect(activations).toBe(2);
    expect(client.calls).toEqual([
      'start',
      'configureCapture',
      'beginCapture',
      'configureCapture',
      'pauseCapture',
    ]);
    expect(policyPauses).toEqual([false, true]);
    expect(controller.getStatus()).toMatchObject({
      policyVersion: 'policy_2',
      state: 'paused',
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
      policyActivation: activePolicyActivation(),
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
      policyActivation: activePolicyActivation(),
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
      policyActivation: activePolicyActivation(),
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
      policyActivation: activePolicyActivation(),
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
      policyActivation: activePolicyActivation(),
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
      policyActivation: activePolicyActivation(),
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
      policyActivation: activePolicyActivation(),
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
      policyActivation: activePolicyActivation(),
      store: createMemoryStore(),
    });
    await controller.start();

    await controller.shutdown();
    await controller.shutdown();

    expect(client.calls).toEqual(['start', 'configureCapture', 'beginCapture', 'stop']);
    expect(controller.getStatus()).toMatchObject({
      state: 'stopped',
    });
  });

  it('discards in-flight and queued policy refreshes after shutdown', async () => {
    let invalidations = 0;
    const pending: Array<
      (configuration: Awaited<ReturnType<CapturePolicyActivation['activate']>>) => void
    > = [];
    const activation: CapturePolicyActivation = {
      async activate() {
        return await new Promise((resolve) => pending.push(resolve));
      },
      invalidate() {
        invalidations += 1;
      },
    };
    const client = new RecordingCaptureHelperClient();
    const controller = createCaptureHelperController({
      client,
      deviceId: 'device_1',
      now: () => now,
      policyActivation: activation,
      store: createMemoryStore(),
    });

    const start = controller.start();
    while (pending.length < 1) await Promise.resolve();
    pending[0]?.(policyConfiguration('policy_initial', `sha256:${'a'.repeat(64)}`));
    await start;

    const inFlightRefresh = controller.refreshPolicy();
    let inFlightSettled = false;
    void inFlightRefresh.then(() => {
      inFlightSettled = true;
    });
    while (pending.length < 2) await Promise.resolve();
    const queuedRefresh = controller.refreshPolicy();
    let queuedSettled = false;
    void queuedRefresh.then(() => {
      queuedSettled = true;
    });
    await flush();
    expect(pending).toHaveLength(2);

    await controller.shutdown();
    await flush();
    const settledAfterShutdown = { inFlightSettled, queuedSettled };
    pending[1]?.(policyConfiguration('policy_stale', `sha256:${'b'.repeat(64)}`));
    await Promise.all([inFlightRefresh, queuedRefresh]);

    expect(pending).toHaveLength(2);
    expect(settledAfterShutdown).toEqual({ inFlightSettled: true, queuedSettled: true });
    expect(invalidations).toBe(1);
    expect(client.calls).toEqual(['start', 'configureCapture', 'beginCapture', 'stop']);
    expect(client.configuredPolicyVersions).toEqual(['policy_initial']);
    expect(client.beginCaptureReasons).toEqual(['runtime_started']);
    expect(controller.getStatus()).toMatchObject({
      policyVersion: 'policy_initial',
      state: 'stopped',
    });
  });

  it('serializes overlapping policy refreshes so the newest helper configuration wins', async () => {
    const pending: Array<
      (configuration: Awaited<ReturnType<CapturePolicyActivation['activate']>>) => void
    > = [];
    const activation: CapturePolicyActivation = {
      async activate() {
        return await new Promise((resolve) => pending.push(resolve));
      },
    };
    const client = new RecordingCaptureHelperClient();
    const controller = createCaptureHelperController({
      client,
      deviceId: 'device_1',
      now: () => now,
      policyActivation: activation,
      store: createMemoryStore(),
    });

    const start = controller.start();
    while (pending.length < 1) await Promise.resolve();
    pending[0]?.(policyConfiguration('policy_initial', `sha256:${'a'.repeat(64)}`));
    await start;

    const olderRefresh = controller.refreshPolicy();
    while (pending.length < 2) await Promise.resolve();
    const newerRefresh = controller.refreshPolicy();
    await flush();
    expect(pending).toHaveLength(2);

    pending[1]?.(policyConfiguration('policy_older', `sha256:${'b'.repeat(64)}`));
    while (pending.length < 3) await Promise.resolve();
    pending[2]?.(policyConfiguration('policy_newer', `sha256:${'c'.repeat(64)}`));
    await Promise.all([olderRefresh, newerRefresh]);

    expect(client.configuredPolicyVersions).toEqual([
      'policy_initial',
      'policy_older',
      'policy_newer',
    ]);
    expect(controller.getStatus()).toMatchObject({
      policyVersion: 'policy_newer',
      state: 'running',
    });
  });
});

class RecordingCaptureHelperClient implements CaptureHelperClient {
  readonly calls: string[] = [];
  readonly configuredPolicyVersions: string[] = [];
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

  async configureCapture(policy: HelperCapturePolicy): Promise<void> {
    this.calls.push('configureCapture');
    this.configuredPolicyVersions.push(policy.version);
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

class PendingResumeCaptureHelperClient extends RecordingCaptureHelperClient {
  resumePending = false;
  private resumeResolver: (() => void) | undefined;

  override async resumeCapture(): Promise<void> {
    this.calls.push('resumeCapture');
    this.resumePending = true;
    await new Promise<void>((resolve) => {
      this.resumeResolver = resolve;
    });
    this.resumePending = false;
  }

  completeResume(): void {
    this.resumeResolver?.();
    this.resumeResolver = undefined;
  }
}

class PendingPauseCaptureHelperClient extends RecordingCaptureHelperClient {
  pausePending = false;
  private pauseResolver: (() => void) | undefined;

  override async pauseCapture(): Promise<void> {
    this.calls.push('pauseCapture');
    this.pausePending = true;
    await new Promise<void>((resolve) => {
      this.pauseResolver = resolve;
    });
    this.pausePending = false;
  }

  completePause(): void {
    this.pauseResolver?.();
    this.pauseResolver = undefined;
  }
}

class PendingStopCaptureHelperClient extends RecordingCaptureHelperClient {
  stopPending = false;
  private stopPromise: Promise<void> | undefined;
  private stopResolver: (() => void) | undefined;

  override async stop(): Promise<void> {
    this.calls.push('stop');
    this.stopPending = true;
    this.stopPromise ??= new Promise<void>((resolve) => {
      this.stopResolver = resolve;
    });
    await this.stopPromise;
    this.stopPending = false;
  }

  completeStop(): void {
    this.stopResolver?.();
    this.stopResolver = undefined;
  }
}

class FailingStopCaptureHelperClient extends RecordingCaptureHelperClient {
  constructor(private failuresRemaining: number) {
    super();
  }

  override async stop(): Promise<void> {
    this.calls.push('stop');
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('helper stop failed');
    }
  }
}

class PendingStartCaptureHelperClient extends RecordingCaptureHelperClient {
  startPending = false;
  private startPromise: Promise<void> | undefined;
  private startResolver: (() => void) | undefined;

  override async start(options?: CaptureHelperStartOptions): Promise<void> {
    this.calls.push('start');
    this.startOptions = options;
    this.startPending = true;
    this.startPromise ??= new Promise<void>((resolve) => {
      this.startResolver = resolve;
    });
    await this.startPromise;
    this.startPending = false;
  }

  completeStart(): void {
    this.startResolver?.();
    this.startResolver = undefined;
  }
}

function policyConfiguration(version: string, policyHash: string) {
  return {
    maxConcurrentOcr: 2,
    policy: {
      defaultAction: 'allow' as const,
      paused: false,
      policyHash,
      rules: [],
      version,
    },
    refreshAfterMs: 60_000,
  };
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

function activePolicyActivation(): CapturePolicyActivation {
  return {
    async activate() {
      return {
        maxConcurrentOcr: 2,
        policy: {
          defaultAction: 'allow',
          paused: false,
          policyHash: `sha256:${'a'.repeat(64)}`,
          rules: [],
          version: 'policy_1',
        },
      };
    },
  };
}

function createPolicyRecoveryHarness(
  initialPauseCauses: readonly ('permission' | 'storage' | 'user')[] = [],
) {
  const client = new RecordingCaptureHelperClient();
  let activationCount = 0;
  const lifecycleRef: { current?: CaptureLifecycle } = {};
  const controller = createCaptureHelperController({
    client,
    deviceId: 'device_1',
    isCaptureAdmissionPaused: () =>
      Boolean(lifecycleRef.current?.getSnapshot().pauseReasons?.length),
    now: () => now,
    onPolicyPauseChange: async (active) => {
      await lifecycleRef.current?.setPolicyPause(active);
    },
    policyActivation: {
      async activate() {
        activationCount += 1;
        if (activationCount === 1) {
          throw new CapturePolicyActivationError('policy_unavailable');
        }
        return policyConfiguration('policy_recovered', `sha256:${'d'.repeat(64)}`);
      },
    },
    store: createMemoryStore(),
  });
  const lifecycle = createCaptureLifecycle({ helper: controller, initialPauseCauses });
  lifecycleRef.current = lifecycle;

  return { client, controller, lifecycle };
}

function createActiveLifecycleHarness(client: CaptureHelperClient) {
  const controller = createCaptureHelperController({
    client,
    deviceId: 'device_1',
    now: () => now,
    policyActivation: activePolicyActivation(),
    store: createMemoryStore(),
  });
  const lifecycle = createCaptureLifecycle({ helper: controller });
  return { controller, lifecycle };
}

class FakeTimers {
  private callback: (() => void) | undefined;

  set = (callback: () => void, _delayMs: number): number => {
    this.callback = callback;
    return 1;
  };

  clear = (_handle: unknown): void => {
    this.callback = undefined;
  };

  fire(): void {
    const callback = this.callback;
    this.callback = undefined;
    callback?.();
  }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 32 && !predicate(); index += 1) {
    await Promise.resolve();
  }
}
