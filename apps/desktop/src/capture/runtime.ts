import type { HelperEnvelope, HelperToMainType } from '../helper/index';
import type { CaptureHelperClient } from '../helper/index';
import type { CapturePoliciesResult } from '../server/index';
import {
  type AssetAvailabilityResolver,
  type AssetReconciliationStore,
  type BackpressureConfig,
  reconcileAssetRefs,
} from '../storage/index';
import { type CaptureAdmissionController, createCaptureAdmissionController } from './admission';
import { createCaptureHelperController } from './helper-controller';
import {
  type CaptureHelperCommandClient,
  type CaptureHelperEventHandler,
  createCaptureHelperEventHandler,
} from './helper-event-handler';
import {
  type CaptureLifecycle,
  type CaptureStartupRecovery,
  createCaptureLifecycle,
} from './lifecycle';
import { createCapturePolicyActivation } from './policy';
import type { CaptureIntakeStore, HelperStateStore } from './store';
import type { CapturePolicyCacheStore } from './store';

const DEFAULT_BACKPRESSURE: BackpressureConfig = {
  maxAssetBytes: 256 * 1024 * 1024,
  maxQueuedJobs: 24,
  resumeAssetBytes: 128 * 1024 * 1024,
  resumeQueuedJobs: 8,
};

const alwaysAvailableAssetResolver: AssetAvailabilityResolver = {
  checkAvailability() {
    return Promise.resolve({ availabilityState: 'available' });
  },
};

export type CaptureRuntimeStore = CaptureIntakeStore &
  HelperStateStore &
  CapturePolicyCacheStore &
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
  store: CaptureRuntimeStore;
  workspaceId: string;
};

export type CaptureRuntime = {
  admission: CaptureAdmissionController;
  eventHandler: CaptureHelperEventHandler;
  lifecycle: CaptureLifecycle;
  commandClient: CaptureHelperCommandClient;
};

export function createCaptureRuntime(options: CaptureRuntimeOptions): CaptureRuntime {
  const lifecycleRef: { current?: CaptureLifecycle } = {};
  const rawEventHandler = createCaptureHelperEventHandler({
    backpressure: options.backpressure ?? DEFAULT_BACKPRESSURE,
    client: options.client,
    deviceId: options.deviceId,
    now: options.now,
    onBackpressurePause: async (reasons) => {
      if (lifecycleRef.current) {
        await lifecycleRef.current.setAutomaticPause(reasons.includes('max_queued_jobs_reached'));
        await lifecycleRef.current.setStoragePause(reasons.includes('max_asset_bytes_reached'));
        return;
      }
      await options.client.pauseCapture();
    },
    onPermissionChange: async (permissions) => {
      await lifecycleRef.current?.setPermissionPause(permissions.screenRecording !== 'granted');
    },
    store: options.store,
    workspaceId: options.workspaceId,
  });
  const eventHandler = decorateEventHandler(rawEventHandler, options.onHelperEnvelope);
  const helper = createCaptureHelperController({
    client: options.client,
    deviceId: options.deviceId,
    eventHandler,
    isCaptureAdmissionPaused: () => {
      return (lifecycleRef.current?.getSnapshot().pauseReasons?.length ?? 0) > 0;
    },
    now: options.now,
    workspaceId: options.workspaceId,
    onPolicyPauseChange: async (active) => {
      await lifecycleRef.current?.setPolicyPause(active);
    },
    policyActivation: createCapturePolicyActivation({
      api: options.policyApi,
      deviceId: options.deviceId,
      now: options.now,
      onActivated: (configuration) => {
        options.onPolicyActivated?.({ maxConcurrentOcr: configuration.maxConcurrentOcr });
      },
      store: options.store,
      workspaceId: options.workspaceId,
    }),
    store: options.store,
  });
  const lifecycle = createCaptureLifecycle({
    assetReconciliation: {
      async reconcile() {
        await reconcileAssetRefs({
          now: options.now(),
          resolver: options.assetResolver ?? alwaysAvailableAssetResolver,
          store: options.store,
          workspaceId: options.workspaceId,
        });
      },
    },
    helper,
    initialPauseCauses: ['permission'],
    startupRecovery: options.startupRecovery,
  });
  lifecycleRef.current = lifecycle;
  const admission = createCaptureAdmissionController({
    backpressure: options.backpressure ?? DEFAULT_BACKPRESSURE,
    lifecycle,
    store: options.store,
    workspaceId: options.workspaceId,
  });

  return { admission, commandClient: options.client, eventHandler, lifecycle };
}

function decorateEventHandler(
  eventHandler: CaptureHelperEventHandler,
  onHelperEnvelope: CaptureRuntimeOptions['onHelperEnvelope'],
): CaptureHelperEventHandler {
  if (!onHelperEnvelope) {
    return eventHandler;
  }

  return {
    getStatus: () => eventHandler.getStatus(),
    subscribeToPermissionStatus: (listener) => eventHandler.subscribeToPermissionStatus(listener),
    async handleEnvelope(envelope) {
      onHelperEnvelope(envelope);
      await eventHandler.handleEnvelope(envelope);
    },
    handleProtocolResult: (result) => eventHandler.handleProtocolResult(result),
  };
}
