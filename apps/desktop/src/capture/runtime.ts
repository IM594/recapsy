import type { CaptureCoverageState, DeviceCaptureDesiredState } from '@recapsy/contracts';
import type {
  CaptureHelperClient,
  CaptureHelperTransportEvent,
  HelperEnvelope,
  HelperToMainType,
} from '../helper/index';
import type { CapturePoliciesResult } from '../server/index';
import {
  type AssetAvailabilityResolver,
  type AssetReconciliationStore,
  type BackpressureConfig,
  type HistoricalAssetReconciliation,
  createHistoricalAssetReconciliation,
  reconcileActiveAssetRefs,
} from '../storage/index';
import {
  type CaptureAdmissionController,
  type CaptureAdmissionStore,
  type CaptureStorageAdmissionOptions,
  createCaptureAdmissionController,
} from './admission';
import {
  type CaptureControl,
  type CaptureControlHelperPort,
  type CaptureCoveragePort,
  type CaptureStartupRecovery,
  createCaptureControl,
} from './control';
import { type CoverageAggregatorEffect, createCoverageAggregator } from './coverage-aggregator';
import {
  type CaptureHelperCommandClient,
  type CaptureHelperEventHandler,
  createCaptureHelperEventHandler,
} from './helper-event-handler';
import { type CapturePolicyController, createCapturePolicyController } from './policy';
import type { CaptureCoverageStore, CaptureIntakeStore } from './store';
import type { CapturePolicyCacheStore } from './store';

export const DEFAULT_CAPTURE_MAX_QUEUED_JOBS = 24;

// Matches the Swift capture engine's own default tick cadence
// (`CaptureEngine.defaultCaptureIntervalMs`), used as the coverage
// aggregator's `intervalMs` until a configured interval is threaded through
// the same `helper.configure` path that already carries `captureIntervalMs`.
const DEFAULT_CAPTURE_INTERVAL_MS = 3000;

// Heartbeats arrive far more often than the read model needs a liveness
// write; only persist `last_alive_at` at most this often so a live device
// does not churn the liveness row on every heartbeat.
const COVERAGE_LIVENESS_DEBOUNCE_MS = 30_000;

const DEFAULT_CAPTURE_BACKPRESSURE: BackpressureConfig = {
  maxAssetBytes: 256 * 1024 * 1024,
  maxQueuedJobs: DEFAULT_CAPTURE_MAX_QUEUED_JOBS,
  maxRetryingJobs: 8,
  resumeAssetBytes: 128 * 1024 * 1024,
  resumeQueuedJobs: 8,
  resumeRetryingJobs: 2,
};

const alwaysAvailableAssetResolver: AssetAvailabilityResolver = {
  checkAvailability() {
    return Promise.resolve({ availabilityState: 'available' });
  },
};

export type CaptureRuntimeStore = CaptureIntakeStore &
  CaptureAdmissionStore &
  CapturePolicyCacheStore &
  CaptureCoverageStore &
  AssetReconciliationStore;

export type CaptureRuntimeOptions = {
  assetResolver?: AssetAvailabilityResolver;
  backpressure?: BackpressureConfig;
  client: CaptureHelperClient & CaptureHelperCommandClient;
  deviceId: string;
  now(): string;
  onHelperEnvelope?(envelope: HelperEnvelope<HelperToMainType>): void;
  onPolicyActivated?(input: { maxConcurrentOcr: number }): void;
  policyApi: {
    getCapturePolicies(input: {
      deviceId: string;
      workspaceId: string;
    }): Promise<CapturePoliciesResult>;
  };
  startupRecovery: CaptureStartupRecovery;
  storageAdmission?: CaptureStorageAdmissionOptions;
  store: CaptureRuntimeStore;
  workspaceId: string;
};

export type CaptureRuntime = {
  admission: CaptureAdmissionController;
  control: CaptureControl;
  commandClient: CaptureHelperCommandClient;
  historicalAssetReconciliation: HistoricalAssetReconciliation;
  policy: CapturePolicyController;
};

export function createCaptureRuntime(options: CaptureRuntimeOptions): CaptureRuntime {
  const assetResolver = options.assetResolver ?? alwaysAvailableAssetResolver;
  const coverage = createCoverageIntegration({
    deviceId: options.deviceId,
    now: options.now,
    store: options.store,
    workspaceId: options.workspaceId,
  });
  const rawEventHandler = createCaptureHelperEventHandler({
    client: options.client,
    coverage: coverage.eventHandlerPort,
    deviceId: options.deviceId,
    now: options.now,
    store: options.store,
    workspaceId: options.workspaceId,
  });
  const eventHandler = decorateEventHandler(rawEventHandler, options.onHelperEnvelope);
  const helper: CaptureControlHelperPort = {
    async start() {
      await options.client.start({
        async handle(event: CaptureHelperTransportEvent) {
          if (event.type === 'envelope') {
            await eventHandler.handleEnvelope(event.envelope);
            return;
          }
          await control.handleHelperTermination(event);
        },
      });
    },
    beginCapture: (reason) => options.client.beginCapture(reason),
    pauseCapture: () => options.client.pauseCapture(),
    resumeCapture: () => options.client.resumeCapture(),
    stop: () => options.client.stop(),
  };
  const policy = createCapturePolicyController({
    api: options.policyApi,
    configure: (capturePolicy, identity) =>
      options.client.configureCapture(capturePolicy, identity),
    deviceId: options.deviceId,
    now: options.now,
    store: options.store,
    workspaceId: options.workspaceId,
  });
  policy.subscribe((snapshot) => {
    if (snapshot.status === 'active') {
      options.onPolicyActivated?.({ maxConcurrentOcr: snapshot.configuration.maxConcurrentOcr });
    }
  });
  const control = createCaptureControl({
    assetReconciliation: {
      async reconcile() {
        await reconcileActiveAssetRefs({
          now: options.now(),
          resolver: assetResolver,
          store: options.store,
          workspaceId: options.workspaceId,
        });
      },
    },
    coverage: coverage.controlPort,
    helper,
    initialPermissions: {
      accessibility: 'unknown',
      screenRecording: 'unknown',
    },
    now: options.now,
    policy,
    startupRecovery: {
      async recover() {
        // A hanging open run from a previous ungraceful shutdown must close
        // before the helper produces any new tick for this device.
        await coverage.recoverAtStartup();
        await options.startupRecovery.recover();
      },
    },
  });
  const admission = createCaptureAdmissionController({
    backpressure: options.backpressure ?? DEFAULT_CAPTURE_BACKPRESSURE,
    storage: options.storageAdmission,
    store: options.store,
    onStatusChange: (status) => control.updateAdmission(status),
  });
  const historicalAssetReconciliation = createHistoricalAssetReconciliation({
    now: options.now,
    resolver: assetResolver,
    store: options.store,
    workspaceId: options.workspaceId,
  });
  eventHandler.subscribeToObservation(async (observation) => {
    if (observation.type !== 'storage_failure') {
      await control.recordHelperObservation(observation);
      if (observation.type === 'capture_result') {
        await admission.reconcile();
      }
      return;
    }
    if (observation.target === 'asset') {
      await admission.reportStorageWriteFailure();
    } else {
      await admission.reportStorageFailure();
    }
  });
  return {
    admission,
    commandClient: options.client,
    control,
    historicalAssetReconciliation,
    policy,
  };
}

/**
 * Bridges the pure `CoverageAggregator` (no I/O) to its `CaptureCoverageStore`
 * persistence, and exposes the two narrow ports its two callers need: the
 * helper event handler (tick-level `capture.coverage` / `capture.result`
 * facts) and the control plane (pause/resume/heartbeat/helper-exit signals).
 * One aggregator instance is shared between both so a run opened from one
 * side is visible to a close triggered from the other.
 */
function createCoverageIntegration(input: {
  deviceId: string;
  now(): string;
  store: CaptureCoverageStore;
  workspaceId: string;
}): {
  controlPort: CaptureCoveragePort;
  eventHandlerPort: {
    observeCoverage(observation: {
      captureId: string;
      state: CaptureCoverageState;
      observedAt: string;
    }): Promise<void>;
    observeCaptureResult(observation: { captureId: string; observedAt: string }): Promise<void>;
  };
  recoverAtStartup(): Promise<void>;
} {
  const aggregator = createCoverageAggregator();
  let desiredState: DeviceCaptureDesiredState = 'running';
  let lastLivenessWriteAtMs: number | undefined;

  async function applyEffects(effects: CoverageAggregatorEffect[]): Promise<void> {
    for (const effect of effects) {
      if (effect.type === 'opened') {
        await input.store.openCoverageSegment({
          coverageState: effect.coverageState,
          deviceId: input.deviceId,
          intervalMs: effect.intervalMs,
          now: input.now(),
          startedAt: effect.startedAt,
          workspaceId: input.workspaceId,
        });
      } else if (effect.type === 'extended') {
        await input.store.extendOpenCoverageSegment({
          deviceId: input.deviceId,
          now: input.now(),
          tickCount: effect.tickCount,
          workspaceId: input.workspaceId,
        });
      } else {
        await input.store.closeOpenCoverageSegment({
          closeReason: effect.segment.closeReason,
          deviceId: input.deviceId,
          endedAt: effect.segment.endedAt,
          now: input.now(),
          workspaceId: input.workspaceId,
        });
      }
    }
  }

  async function writeLiveness(
    observedAt: string,
    state: DeviceCaptureDesiredState,
  ): Promise<void> {
    desiredState = state;
    lastLivenessWriteAtMs = Date.parse(observedAt);
    await input.store.upsertDeviceCaptureLiveness({
      deviceId: input.deviceId,
      desiredState: state,
      lastAliveAt: observedAt,
      now: input.now(),
      workspaceId: input.workspaceId,
    });
  }

  return {
    controlPort: {
      handleHelperExit(observedAt) {
        void applyEffects(aggregator.handleHelperExit({ observedAt })).catch(() => undefined);
      },
      pause(observedAt) {
        void applyEffects(
          aggregator.pause({ intervalMs: DEFAULT_CAPTURE_INTERVAL_MS, observedAt }),
        ).catch(() => undefined);
        void writeLiveness(observedAt, 'paused').catch(() => undefined);
      },
      recordHeartbeat(observedAt) {
        const observedAtMs = Date.parse(observedAt);
        if (
          lastLivenessWriteAtMs === undefined ||
          observedAtMs - lastLivenessWriteAtMs >= COVERAGE_LIVENESS_DEBOUNCE_MS
        ) {
          void writeLiveness(observedAt, desiredState).catch(() => undefined);
        }
      },
      resume(observedAt) {
        void applyEffects(aggregator.resume({ observedAt })).catch(() => undefined);
        void writeLiveness(observedAt, 'running').catch(() => undefined);
      },
    },
    eventHandlerPort: {
      async observeCoverage(observation) {
        await applyEffects(
          aggregator.observeCoverage({
            intervalMs: DEFAULT_CAPTURE_INTERVAL_MS,
            observedAt: observation.observedAt,
            state: observation.state,
          }),
        );
      },
      async observeCaptureResult(observation) {
        await applyEffects(aggregator.observeCaptureResult({ observedAt: observation.observedAt }));
      },
    },
    async recoverAtStartup() {
      await input.store.recoverHangingCoverageSegment({
        deviceId: input.deviceId,
        now: input.now(),
        workspaceId: input.workspaceId,
      });
    },
  };
}

function decorateEventHandler(
  eventHandler: CaptureHelperEventHandler,
  onHelperEnvelope: CaptureRuntimeOptions['onHelperEnvelope'],
): CaptureHelperEventHandler {
  if (!onHelperEnvelope) {
    return eventHandler;
  }

  return {
    subscribeToObservation: (listener) => eventHandler.subscribeToObservation(listener),
    async handleEnvelope(envelope) {
      try {
        onHelperEnvelope(envelope);
      } catch {
        // Diagnostics must never make a healthy helper transport fail closed.
      }
      await eventHandler.handleEnvelope(envelope);
    },
    handleProtocolResult: (result) => eventHandler.handleProtocolResult(result),
  };
}
