import { describe, expect, it } from 'bun:test';
import { createMemoryStore } from '../../storage';
import { recoverSyncQueue } from '../../sync/index';
import {
  type CaptureControlHelperPort,
  type CaptureControlOptions,
  type CaptureCoveragePort,
  createCaptureControl as createControlActor,
} from '../control';
import type { CapturePolicyConfiguration, CapturePolicyController } from '../policy';

describe('capture control', () => {
  it('keeps the runtime harness test double out of production modules', async () => {
    const productionHarnessModule = Bun.file(
      new URL('../../harness/runtime-harness.ts', import.meta.url),
    );

    expect(await productionHarnessModule.exists()).toBe(false);
  });

  it('enters running after a successful start', async () => {
    const harness = createControlHarness();

    await harness.control.start();

    expect(harness.control.getSnapshot()).toMatchObject({
      status: 'running',
      menuBarActive: false,
    });
    expect(harness.helper.calls).toEqual([
      'start',
      'policy.refresh',
      'beginCapture:runtime_started',
    ]);
  });

  it('leaves running when the helper transport reports an unexpected exit', async () => {
    const harness = createControlHarness();

    await harness.control.start();
    await harness.control.handleHelperTermination({
      code: 9,
      reason: 'process_crashed',
      type: 'process_exit',
    });

    expect(harness.control.getSnapshot()).toMatchObject({
      captureHelper: {
        lastSafeError: {
          code: 'helper_unexpected_exit',
        },
        state: 'failed',
      },
      status: 'stopped',
    });
    expect(harness.control.getSnapshot().lastSafeError?.code).toBe('helper_unexpected_exit');
  });

  it('derives the stopped helper projection from the control phase', async () => {
    const harness = createControlHarness();

    await harness.control.start();
    await harness.control.stop();

    expect(harness.control.getSnapshot()).toMatchObject({
      captureHelper: { state: 'stopped' },
      status: 'stopped',
    });
  });

  it('clears an active helper failure after a successful restart', async () => {
    const harness = createControlHarness();

    await harness.control.start();
    await harness.control.handleHelperTermination({
      code: 9,
      reason: 'process_crashed',
      type: 'process_exit',
    });
    await harness.control.start();

    expect(harness.control.getSnapshot()).toMatchObject({
      captureHelper: { state: 'running' },
      status: 'running',
    });
    expect(harness.control.getSnapshot().lastSafeError).toBeUndefined();
  });

  it('does not classify a requested helper exit as an operational failure', async () => {
    const harness = createControlHarness();

    await harness.control.recordHelperObservation({
      observedAt: '2026-07-19T08:00:00.000Z',
      reason: 'shutdown_requested',
      type: 'helper_exit',
    });

    expect(harness.control.getSnapshot().lastSafeError).toBeUndefined();
  });

  it('projects helper observations from one control snapshot', async () => {
    const harness = createControlHarness();

    await harness.control.recordHelperObservation({
      code: 'capture_failed',
      observedAt: '2026-07-19T08:00:00.000Z',
      type: 'capture_error',
    });
    await harness.control.recordHelperObservation({
      code: 'capture_failed',
      observedAt: '2026-07-19T08:00:01.000Z',
      type: 'capture_error',
    });

    expect(harness.control.getSnapshot()).toMatchObject({
      captureFailureCount: 2,
      lastSafeError: { code: 'capture_failed' },
    });
    expect(harness.control.getSnapshot()).not.toHaveProperty('lastObservedAt');

    await harness.control.recordHelperObservation({
      observedAt: '2026-07-19T08:00:02.000Z',
      type: 'capture_result',
    });

    expect(harness.control.getSnapshot().captureFailureCount).toBe(0);
    expect(harness.control.getSnapshot().lastSafeError).toBeUndefined();
  });

  it('keeps consecutive capture failures until a durable result', async () => {
    const harness = createControlHarness();

    await harness.control.recordHelperObservation({
      code: 'capture_failed',
      observedAt: '2026-07-19T08:00:00.000Z',
      type: 'capture_error',
    });
    await harness.control.recordHelperObservation({
      code: 'asset_write_failed',
      observedAt: '2026-07-19T08:00:01.000Z',
      type: 'capture_error',
    });

    expect(harness.control.getSnapshot().captureFailureCount).toBe(1);
  });

  it('tracks only heartbeat time in the control snapshot', async () => {
    const harness = createControlHarness();

    await harness.control.recordHelperObservation({
      observedAt: '2026-07-19T08:00:00.000Z',
      type: 'heartbeat',
    });

    expect(harness.control.getSnapshot()).toMatchObject({
      lastHeartbeatAt: '2026-07-19T08:00:00.000Z',
    });
    expect(harness.control.getSnapshot()).not.toHaveProperty('lastObservedAt');
    expect(harness.control.getSnapshot()).not.toHaveProperty('lastSkippedCapture');
  });

  it('projects the latest permission fact from the control snapshot', async () => {
    const harness = createControlHarness();

    await harness.control.recordHelperObservation({
      observedAt: '2026-07-19T08:00:00.000Z',
      permissions: { accessibility: 'granted', screenRecording: 'denied' },
      type: 'permission',
    });

    expect(harness.control.getSnapshot()).toMatchObject({
      permissions: { accessibility: 'granted', screenRecording: 'denied' },
    });
  });

  it('runs helper start, policy configure acknowledgement, and capture begin in order', async () => {
    const calls: string[] = [];
    const control = createCaptureControl({
      helper: createRecordingHelper(calls),
      policy: createRecordingPolicy(calls),
    });

    await control.start();

    expect(calls).toEqual(['start', 'policy.refresh', 'beginCapture:runtime_started']);
    expect(control.getSnapshot()).toMatchObject({
      captureHelper: {
        policyHash: activePolicyConfiguration.policy.policyHash,
        policyVersion: activePolicyConfiguration.policy.version,
        state: 'running',
      },
      status: 'running',
    });
  });

  it('never begins capture when the acknowledged policy is paused', async () => {
    const calls: string[] = [];
    const control = createCaptureControl({
      helper: createRecordingHelper(calls),
      policy: createRecordingPolicy(calls, {
        ...activePolicyConfiguration,
        policy: { ...activePolicyConfiguration.policy, paused: true },
      }),
    });

    await control.start();

    expect(control.getSnapshot()).toMatchObject({
      pauseReasons: ['policy'],
      status: 'paused',
    });
    expect(control.getSnapshot()).not.toHaveProperty('pauseReason');
    expect(calls).toEqual(['start', 'policy.refresh']);
  });

  it('fails closed without beginning capture when startup policy refresh fails', async () => {
    const calls: string[] = [];
    const control = createCaptureControl({
      helper: createRecordingHelper(calls),
      policy: createPolicyDouble(async () => {
        calls.push('policy.refresh');
        throw new Error('policy fetch failed');
      }),
    });

    await control.start();

    expect(calls).toEqual(['start', 'policy.refresh']);
    expect(control.getSnapshot()).toMatchObject({
      captureHelper: {
        lastSafeError: { code: 'policy_unavailable' },
        state: 'paused',
      },
      pauseReasons: ['policy'],
      status: 'paused',
    });
  });

  it('keeps a startup admission gate closed until every pause cause clears', async () => {
    const helper = createRecordingHelper([]);
    const control = createCaptureControl({
      helper,
      policy: createRecordingPolicy(helper.calls),
      initialPermissions: { accessibility: 'unknown', screenRecording: 'denied' },
    });

    await control.updateAdmission({ reasons: ['max_queued_jobs_reached'] });
    await control.start();
    await control.updateAdmission({ reasons: [] });
    await control.recordHelperObservation({
      observedAt: '2026-07-19T08:00:00.000Z',
      permissions: { accessibility: 'unknown', screenRecording: 'granted' },
      type: 'permission',
    });

    expect(helper.calls).toEqual(['start', 'policy.refresh', 'beginCapture:runtime_started']);
    expect(control.getSnapshot()).toMatchObject({ status: 'running' });
  });

  it('keeps capture running in the menu bar when the last window closes', async () => {
    const harness = createControlHarness();
    await harness.control.start();

    await harness.control.handleLastWindowClosed();

    expect(harness.control.getSnapshot()).toMatchObject({
      status: 'running',
      menuBarActive: true,
    });
    expect(harness.helper.calls).toEqual([
      'start',
      'policy.refresh',
      'beginCapture:runtime_started',
    ]);
  });

  it('pauses and resumes capture without stopping the control', async () => {
    const harness = createControlHarness();
    await harness.control.start();

    await harness.control.pause();

    expect(harness.control.getSnapshot()).toMatchObject({
      status: 'paused',
      menuBarActive: false,
    });

    await harness.control.resume();

    expect(harness.control.getSnapshot()).toMatchObject({
      status: 'running',
      menuBarActive: false,
    });
    expect(harness.helper.calls).toEqual([
      'start',
      'policy.refresh',
      'beginCapture:runtime_started',
      'pauseCapture',
      'resumeCapture',
    ]);
  });

  it('records an actual helper pause and resume through the coverage port', async () => {
    const coverageCalls: string[] = [];
    const control = createCaptureControl({
      coverage: recordingCoveragePort(coverageCalls),
      helper: createRecordingHelper([]),
      now: () => '2026-07-19T09:00:00.000Z',
      policy: createRecordingPolicy([]),
    });

    await control.start();
    await control.pause();
    await control.resume();

    expect(coverageCalls).toEqual([
      'pause:2026-07-19T09:00:00.000Z',
      'resume:2026-07-19T09:00:00.000Z',
    ]);
  });

  it('advances the coverage tracker on every heartbeat', async () => {
    const coverageCalls: string[] = [];
    const harness = createControlHarness({ coverage: recordingCoveragePort(coverageCalls) });

    await harness.control.recordHelperObservation({
      observedAt: '2026-07-19T08:00:05.000Z',
      type: 'heartbeat',
    });

    expect(coverageCalls).toEqual(['heartbeat:2026-07-19T08:00:05.000Z']);
  });

  it('closes the coverage tracker on a graceful helper exit', async () => {
    const coverageCalls: string[] = [];
    const harness = createControlHarness({ coverage: recordingCoveragePort(coverageCalls) });

    await harness.control.recordHelperObservation({
      observedAt: '2026-07-19T08:00:09.000Z',
      reason: 'process_crashed',
      type: 'helper_exit',
    });

    expect(coverageCalls).toEqual(['helperExit:2026-07-19T08:00:09.000Z']);
  });

  it('closes the coverage tracker when the helper process terminates', async () => {
    const coverageCalls: string[] = [];
    const control = createCaptureControl({
      coverage: recordingCoveragePort(coverageCalls),
      helper: createRecordingHelper([]),
      now: () => '2026-07-19T09:30:00.000Z',
      policy: createRecordingPolicy([]),
    });
    await control.start();

    await control.handleHelperTermination({
      code: 9,
      reason: 'process_crashed',
      type: 'process_exit',
    });

    expect(coverageCalls).toEqual(['helperExit:2026-07-19T09:30:00.000Z']);
  });

  it('serializes overlapping user intents so the latest resume wins', async () => {
    const pause = Promise.withResolvers<void>();
    let pauseStarted = false;
    const control = createCaptureControl({
      helper: {
        async beginCapture() {},
        async pauseCapture(): Promise<void> {
          pauseStarted = true;
          await pause.promise;
        },
        async resumeCapture(): Promise<void> {},
        async stop(): Promise<void> {},
        async start(): Promise<void> {},
      },
      policy: createRecordingPolicy([]),
    });
    await control.start();

    const pendingPause = control.pause();
    while (!pauseStarted) await Promise.resolve();
    const pendingResume = control.resume();
    pause.resolve();
    await Promise.all([pendingPause, pendingResume]);

    expect(control.getSnapshot()).toMatchObject({ status: 'running' });
    expect(control.getSnapshot().pauseReasons).toBeUndefined();
  });

  it('keeps an automatic pause active when the user asks to resume', async () => {
    const harness = createControlHarness();
    await harness.control.start();

    await harness.control.updateAdmission({
      reasons: ['max_queued_jobs_reached'],
    });
    await harness.control.resume();

    expect(harness.control.getSnapshot()).toMatchObject({
      pauseReasons: ['backpressure'],
      status: 'paused',
    });
    expect(harness.control.getSnapshot()).not.toHaveProperty('pauseReason');
    expect(harness.helper.calls).toEqual([
      'start',
      'policy.refresh',
      'beginCapture:runtime_started',
      'pauseCapture',
    ]);
  });

  it('does not resume an automatically paused helper after a user pause takes ownership', async () => {
    const harness = createControlHarness();
    await harness.control.start();

    await harness.control.updateAdmission({
      reasons: ['max_queued_jobs_reached'],
    });
    await harness.control.pause();
    await harness.control.updateAdmission({ reasons: [] });

    expect(harness.control.getSnapshot()).toMatchObject({
      pauseReasons: ['user'],
      status: 'paused',
    });
    expect(harness.control.getSnapshot()).not.toHaveProperty('pauseReason');
    expect(harness.helper.calls).toEqual([
      'start',
      'policy.refresh',
      'beginCapture:runtime_started',
      'pauseCapture',
    ]);

    await harness.control.resume();
    expect(harness.helper.calls).toEqual([
      'start',
      'policy.refresh',
      'beginCapture:runtime_started',
      'pauseCapture',
      'resumeCapture',
    ]);
  });

  it('preserves permission and admission facts across stop and restart', async () => {
    const harness = createControlHarness();
    await harness.control.start();
    await harness.control.recordHelperObservation({
      observedAt: '2026-07-19T08:00:00.000Z',
      permissions: { accessibility: 'unknown', screenRecording: 'denied' },
      type: 'permission',
    });
    await harness.control.updateAdmission({
      reasons: ['max_queued_jobs_reached'],
    });

    await harness.control.stop();
    await harness.control.start();

    expect(harness.control.getSnapshot()).toMatchObject({
      pauseReasons: ['permission', 'backpressure'],
      status: 'paused',
    });
  });

  it('cancels startup before the helper starts when stop is the latest intent', async () => {
    const recovery = Promise.withResolvers<void>();
    const calls: string[] = [];
    let recoveryStarted = false;
    const control = createCaptureControl({
      helper: createRecordingHelper(calls),
      policy: createRecordingPolicy(calls),
      startupRecovery: {
        async recover(): Promise<void> {
          calls.push('recover');
          recoveryStarted = true;
          await recovery.promise;
        },
      },
    });

    const pendingStart = control.start();
    while (!recoveryStarted) await Promise.resolve();
    const pendingStop = control.stop();
    recovery.resolve();
    await Promise.all([pendingStart, pendingStop]);

    expect(calls).toEqual(['recover']);
    expect(control.getSnapshot()).toMatchObject({ status: 'stopped' });
  });

  it('does not begin capture when stop arrives during policy acknowledgement', async () => {
    const calls: string[] = [];
    const policy = Promise.withResolvers<CapturePolicyConfiguration>();
    const control = createCaptureControl({
      helper: createRecordingHelper(calls),
      policy: createPolicyDouble(async () => {
        calls.push('policy.refresh');
        return policy.promise;
      }),
    });

    const starting = control.start();
    while (!calls.includes('policy.refresh')) await Promise.resolve();
    const stopping = control.stop();
    policy.resolve(activePolicyConfiguration);
    await Promise.all([starting, stopping]);

    expect(calls).toEqual(['start', 'policy.refresh', 'shutdown']);
    expect(control.getSnapshot().status).toBe('stopped');
  });

  it('waits for helper shutdown when quit arrives while helper startup is pending', async () => {
    const calls: string[] = [];
    const helperStart = Promise.withResolvers<void>();
    const control = createCaptureControl({
      helper: {
        async beginCapture(): Promise<void> {
          calls.push('beginCapture');
        },
        async pauseCapture(): Promise<void> {},
        async resumeCapture(): Promise<void> {},
        async start(): Promise<void> {
          calls.push('start');
          await helperStart.promise;
        },
        async stop(): Promise<void> {
          calls.push('shutdown');
        },
      },
      policy: createRecordingPolicy(calls),
    });

    const starting = control.start();
    while (!calls.includes('start')) await Promise.resolve();

    let quitSettled = false;
    const quitting = control.requestQuit().then(() => {
      quitSettled = true;
    });
    await Promise.resolve();

    expect(quitSettled).toBe(false);
    expect(calls).toEqual(['start']);

    helperStart.resolve();
    await Promise.all([starting, quitting]);

    expect(calls).toEqual(['start', 'shutdown']);
    expect(control.getSnapshot().status).toBe('stopped');
  });

  it('stops without waiting for an unresolved policy activation', async () => {
    const calls: string[] = [];
    const policy = Promise.withResolvers<CapturePolicyConfiguration>();
    const control = createCaptureControl({
      helper: createRecordingHelper(calls),
      policy: createPolicyDouble(async () => {
        calls.push('policy.refresh');
        return policy.promise;
      }),
    });

    const starting = control.start();
    while (!calls.includes('policy.refresh')) await Promise.resolve();

    await control.stop();

    expect(calls).toEqual(['start', 'policy.refresh', 'shutdown']);
    expect(control.getSnapshot().status).toBe('stopped');

    policy.resolve(activePolicyConfiguration);
    await starting;

    expect(calls).toEqual(['start', 'policy.refresh', 'shutdown']);
  });

  it('shuts down instead of claiming paused when the helper rejects pause', async () => {
    const calls: string[] = [];
    const helper = createRecordingHelper(calls);
    helper.pauseCapture = async () => {
      calls.push('pauseCapture');
      throw new Error('pause failed');
    };
    const control = createCaptureControl({ helper, policy: createRecordingPolicy(calls) });
    await control.start();

    await expect(control.pause()).rejects.toThrow('pause failed');

    expect(calls).toContain('shutdown');
    expect(control.getSnapshot()).toMatchObject({ status: 'stopped' });
  });

  it('retries a failed shutdown before honoring a restart intent', async () => {
    const calls: string[] = [];
    let shutdownFailures = 1;
    const control = createCaptureControl({
      helper: {
        async beginCapture() {},
        async pauseCapture(): Promise<void> {},
        async resumeCapture(): Promise<void> {},
        async stop(): Promise<void> {
          calls.push('shutdown');
          if (shutdownFailures > 0) {
            shutdownFailures -= 1;
            throw new Error('helper stop failed');
          }
        },
        async start(): Promise<void> {
          calls.push('start');
        },
      },
      policy: createRecordingPolicy(calls),
    });
    await control.start();

    await expect(control.stop()).rejects.toThrow('helper stop failed');
    expect(control.getSnapshot()).toMatchObject({ status: 'stopping' });

    await control.start();

    expect(calls).toEqual([
      'start',
      'policy.refresh',
      'shutdown',
      'shutdown',
      'start',
      'policy.refresh',
    ]);
    expect(control.getSnapshot()).toMatchObject({ status: 'running' });
  });

  it('shuts the helper down and stops the control on quit', async () => {
    const harness = createControlHarness();
    await harness.control.start();

    await harness.control.requestQuit();

    expect(harness.control.getSnapshot()).toMatchObject({
      status: 'stopped',
      menuBarActive: false,
    });
    expect(harness.helper.calls).toEqual([
      'start',
      'policy.refresh',
      'beginCapture:runtime_started',
      'shutdown',
    ]);
  });

  it('runs startup recovery before helper capture starts', async () => {
    const calls: string[] = [];
    const control = createCaptureControl({
      helper: createRecordingHelper(calls),
      policy: createRecordingPolicy(calls),
      startupRecovery: {
        async recover(): Promise<void> {
          calls.push('recover');
        },
      },
    });

    await control.start();

    expect(control.getSnapshot()).toMatchObject({
      status: 'running',
      menuBarActive: false,
    });
    expect(calls).toEqual(['recover', 'start', 'policy.refresh', 'beginCapture:runtime_started']);
  });

  it('runs asset ref reconciliation after startup recovery and before helper capture starts', async () => {
    const calls: string[] = [];
    const control = createCaptureControl({
      assetReconciliation: {
        async reconcile(): Promise<void> {
          calls.push('reconcile');
        },
      },
      helper: createRecordingHelper(calls),
      policy: createRecordingPolicy(calls),
      startupRecovery: {
        async recover(): Promise<void> {
          calls.push('recover');
        },
      },
    });

    await control.start();

    expect(control.getSnapshot()).toMatchObject({
      status: 'running',
      menuBarActive: false,
    });
    expect(calls).toEqual([
      'recover',
      'reconcile',
      'start',
      'policy.refresh',
      'beginCapture:runtime_started',
    ]);
  });

  it('can wire interrupted outbox recovery into control startup through dependency injection', async () => {
    const store = createMemoryStore();
    const calls: string[] = [];
    await store.createOutboxJob({
      assetRefId: 'asset_1',
      createdAt: '2026-07-06T00:00:00.000Z',
      deviceId: 'device_1',
      id: 'job_1',
      idempotencyKey: 'idem_1',
      payloadHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      workspaceId: 'workspace_1',
    });
    await store.updateOutboxJobState('job_1', {
      now: '2026-07-06T00:00:01.000Z',
      state: 'syncing',
    });
    const control = createCaptureControl({
      helper: createRecordingHelper(calls),
      policy: createRecordingPolicy(calls),
      startupRecovery: {
        async recover(): Promise<void> {
          calls.push('recover');
          await recoverSyncQueue({
            now: '2026-07-06T00:00:02.000Z',
            store,
          });
        },
      },
    });

    await control.start();

    expect(calls).toEqual(['recover', 'start', 'policy.refresh', 'beginCapture:runtime_started']);
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      lastSafeError: {
        code: 'interrupted_during_sync',
      },
      nextRetryAt: '2026-07-06T00:00:02.000Z',
      state: 'pending',
    });
  });

  it('fails closed when startup recovery fails before helper capture starts', async () => {
    const calls: string[] = [];
    const control = createCaptureControl({
      helper: createRecordingHelper(calls),
      policy: createRecordingPolicy(calls),
      startupRecovery: {
        async recover(): Promise<void> {
          calls.push('recover');
          throw new Error('startup recovery failed');
        },
      },
    });

    await expect(control.start()).rejects.toThrow('startup recovery failed');

    expect(control.getSnapshot()).toMatchObject({
      status: 'stopped',
      menuBarActive: false,
    });
    expect(calls).toEqual(['recover']);
  });

  it('fails closed when asset ref reconciliation fails before helper capture starts', async () => {
    const calls: string[] = [];
    const control = createCaptureControl({
      assetReconciliation: {
        async reconcile(): Promise<void> {
          calls.push('reconcile');
          throw new Error('asset ref reconciliation failed');
        },
      },
      helper: createRecordingHelper(calls),
      policy: createRecordingPolicy(calls),
      startupRecovery: {
        async recover(): Promise<void> {
          calls.push('recover');
        },
      },
    });

    await expect(control.start()).rejects.toThrow('asset ref reconciliation failed');

    expect(control.getSnapshot()).toMatchObject({
      status: 'stopped',
      menuBarActive: false,
    });
    expect(calls).toEqual(['recover', 'reconcile']);
  });

  it('fails closed when helper start fails after operational checks', async () => {
    const calls: string[] = [];
    const control = createCaptureControl({
      assetReconciliation: {
        async reconcile(): Promise<void> {
          calls.push('reconcile');
        },
      },
      helper: {
        async beginCapture() {},
        async pauseCapture(): Promise<void> {
          calls.push('pauseCapture');
        },
        async resumeCapture(): Promise<void> {
          calls.push('resumeCapture');
        },
        async stop(): Promise<void> {
          calls.push('shutdown');
        },
        async start(): Promise<void> {
          calls.push('start');
          throw new Error('helper launch failed');
        },
      },
      policy: createRecordingPolicy(calls),
      startupRecovery: {
        async recover(): Promise<void> {
          calls.push('recover');
        },
      },
    });

    await expect(control.start()).rejects.toThrow('helper launch failed');

    expect(control.getSnapshot()).toMatchObject({
      status: 'stopped',
      menuBarActive: false,
      captureHelper: {
        state: 'failed',
        lastSafeError: {
          code: 'helper_start_failed',
        },
      },
    });
    expect(calls).toEqual(['recover', 'reconcile', 'start']);
  });
});

function createCaptureControl(
  options: Partial<Pick<CaptureControlOptions, 'coverage' | 'now'>> &
    Omit<CaptureControlOptions, 'coverage' | 'now'>,
) {
  return createControlActor({
    coverage: createNoopCoveragePort(),
    initialPermissions: { accessibility: 'granted', screenRecording: 'granted' },
    now: () => '2026-07-19T08:00:00.000Z',
    ...options,
  });
}

function createNoopCoveragePort(): CaptureCoveragePort {
  return {
    handleHelperExit() {},
    pause() {},
    recordHeartbeat() {},
    resume() {},
  };
}

function createControlHarness(overrides: Partial<CaptureControlOptions> = {}) {
  const helper = createRecordingHelper([]);

  return {
    helper,
    control: createCaptureControl({
      helper,
      initialPermissions: { accessibility: 'granted', screenRecording: 'granted' },
      policy: createRecordingPolicy(helper.calls),
      ...overrides,
    }),
  };
}

function recordingCoveragePort(calls: string[]): CaptureCoveragePort {
  return {
    handleHelperExit: (observedAt) => calls.push(`helperExit:${observedAt}`),
    pause: (observedAt) => calls.push(`pause:${observedAt}`),
    recordHeartbeat: (observedAt) => calls.push(`heartbeat:${observedAt}`),
    resume: (observedAt) => calls.push(`resume:${observedAt}`),
  };
}

function createRecordingHelper(
  calls: string[],
): CaptureControlHelperPort & { readonly calls: string[] } {
  return {
    calls,
    async beginCapture(reason): Promise<void> {
      calls.push(`beginCapture:${reason}`);
    },
    async pauseCapture(): Promise<void> {
      calls.push('pauseCapture');
    },
    async resumeCapture(): Promise<void> {
      calls.push('resumeCapture');
    },
    async stop(): Promise<void> {
      calls.push('shutdown');
    },
    async start(): Promise<void> {
      calls.push('start');
    },
  };
}

const activePolicyConfiguration: CapturePolicyConfiguration = {
  maxConcurrentOcr: 1,
  policy: {
    defaultAction: 'allow',
    paused: false,
    policyHash: `sha256:${'a'.repeat(64)}`,
    rules: [],
    version: 'policy_1',
  },
};

function createRecordingPolicy(
  calls: string[],
  configuration: CapturePolicyConfiguration = activePolicyConfiguration,
): CapturePolicyController {
  return createPolicyDouble(async () => {
    calls.push('policy.refresh');
    return configuration;
  });
}

function createPolicyDouble(
  refresh: () => Promise<CapturePolicyConfiguration>,
): CapturePolicyController {
  let snapshot: import('../policy').CapturePolicySnapshot = { status: 'inactive' };
  const listeners = new Set<
    (next: import('../policy').CapturePolicySnapshot) => Promise<void> | void
  >();
  let activeSession: object | undefined;
  let drain: Promise<void> = Promise.resolve();
  const queue = (publish: boolean): Promise<CapturePolicyConfiguration> => {
    const session = activeSession;
    if (!session) return Promise.reject(new Error('policy inactive'));
    const result = drain.then(async () => {
      try {
        const configuration = await refresh();
        if (activeSession !== session) return configuration;
        snapshot = { configuration, status: 'active' };
        if (publish) {
          await Promise.all([...listeners].map((listener) => listener(snapshot)));
        }
        return configuration;
      } catch (error) {
        if (activeSession === session) {
          snapshot = { status: 'blocked' };
          if (publish) {
            await Promise.all([...listeners].map((listener) => listener(snapshot)));
          }
        }
        throw error;
      }
    });
    drain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return {
    activate() {
      activeSession ??= {};
      return queue(false);
    },
    async blockBundle() {
      throw new Error('local rules are outside this control test double');
    },
    deactivate() {
      activeSession = undefined;
      snapshot =
        snapshot.status === 'active'
          ? { configuration: snapshot.configuration, status: 'inactive' }
          : { status: 'inactive' };
    },
    getSnapshot() {
      return snapshot;
    },
    async listLocalRules() {
      return [];
    },
    async removeLocalRule() {
      return false;
    },
    refresh: () => queue(true),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
