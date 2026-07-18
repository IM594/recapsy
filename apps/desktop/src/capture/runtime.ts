import type { HelperEnvelope, HelperToMainType } from '../helper/index';
import type { CaptureHelperClient } from '../helper/index';
import type { CapturePoliciesResult } from '../server/index';
import {
  type AssetAvailabilityResolver,
  type AssetReconciliationStore,
  type BackpressureConfig,
  reconcileAssetRefs,
} from '../storage/index';
import {
  type CaptureAdmissionController,
  type CaptureStorageAdmissionOptions,
  createCaptureAdmissionController,
} from './admission';
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
import { type LocalCapturePolicyManager, createLocalCapturePolicyManager } from './local-policy';
import { createCapturePolicyActivation } from './policy';
import type { CaptureIntakeStore, HelperStateStore } from './store';
import type { CapturePolicyCacheStore } from './store';

export const DEFAULT_CAPTURE_MAX_QUEUED_JOBS = 24;

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
  storageAdmission?: CaptureStorageAdmissionOptions;
  store: CaptureRuntimeStore;
  workspaceId: string;
};

export type CaptureRuntime = {
  admission: CaptureAdmissionController;
  eventHandler: CaptureHelperEventHandler;
  lifecycle: CaptureLifecycle;
  commandClient: CaptureHelperCommandClient;
  localPolicy: LocalCapturePolicyManager;
};

export function createCaptureRuntime(options: CaptureRuntimeOptions): CaptureRuntime {
  const admissionRef: { current?: CaptureAdmissionController } = {};
  const lifecycleRef: { current?: CaptureLifecycle } = {};
  const rawEventHandler = createCaptureHelperEventHandler({
    backpressure: options.backpressure ?? DEFAULT_CAPTURE_BACKPRESSURE,
    client: options.client,
    deviceId: options.deviceId,
    now: options.now,
    onBackpressurePause: async () => {
      if (admissionRef.current) {
        await admissionRef.current.reconcile();
        return;
      }
      await options.client.pauseCapture();
    },
    onPermissionChange: async (permissions) => {
      await lifecycleRef.current?.setPermissionPause(permissions.screenRecording !== 'granted');
    },
    onStorageFailure: async () => {
      await admissionRef.current?.reportStorageFailure();
    },
    onStorageWriteFailure: async () => {
      await admissionRef.current?.reportStorageWriteFailure();
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
    backpressure: options.backpressure ?? DEFAULT_CAPTURE_BACKPRESSURE,
    lifecycle,
    storage: options.storageAdmission,
    store: options.store,
    workspaceId: options.workspaceId,
  });
  admissionRef.current = admission;
  const localPolicy = createLocalCapturePolicyManager({
    now: options.now,
    reloadPolicy: () => helper.refreshPolicy(),
    store: options.store,
  });

  return { admission, commandClient: options.client, eventHandler, lifecycle, localPolicy };
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
