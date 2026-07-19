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
  reconcileAssetRefs,
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
  type CaptureStartupRecovery,
  createCaptureControl,
} from './control';
import {
  type CaptureHelperCommandClient,
  type CaptureHelperEventHandler,
  createCaptureHelperEventHandler,
} from './helper-event-handler';
import { type CapturePolicyController, createCapturePolicyController } from './policy';
import type { CaptureIntakeStore } from './store';
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
  CaptureAdmissionStore &
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
  control: CaptureControl;
  commandClient: CaptureHelperCommandClient;
  policy: CapturePolicyController;
};

export function createCaptureRuntime(options: CaptureRuntimeOptions): CaptureRuntime {
  const rawEventHandler = createCaptureHelperEventHandler({
    client: options.client,
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
        await reconcileAssetRefs({
          now: options.now(),
          resolver: options.assetResolver ?? alwaysAvailableAssetResolver,
          store: options.store,
          workspaceId: options.workspaceId,
        });
      },
    },
    helper,
    initialPermissions: {
      accessibility: 'unknown',
      screenRecording: 'unknown',
    },
    policy,
    startupRecovery: options.startupRecovery,
  });
  const admission = createCaptureAdmissionController({
    backpressure: options.backpressure ?? DEFAULT_CAPTURE_BACKPRESSURE,
    storage: options.storageAdmission,
    store: options.store,
    onStatusChange: (status) => control.updateAdmission(status),
  });
  eventHandler.subscribeToObservation(async (observation) => {
    if (observation.type !== 'storage_failure') {
      await control.recordHelperObservation(observation);
      return;
    }
    if (observation.target === 'asset') {
      await admission.reportStorageWriteFailure();
    } else {
      await admission.reportStorageFailure();
    }
  });
  return { admission, commandClient: options.client, control, policy };
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
