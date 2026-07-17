import type { HelperEnvelope, HelperToMainType } from '../helper/index';
import type { CaptureHelperClient } from '../helper/index';
import type { CapturePoliciesResult } from '../server/index';
import {
  type AssetAvailabilityResolver,
  type AssetReconciliationStore,
  type BackpressureConfig,
  reconcileAssetRefs,
} from '../storage/index';
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
  maxAssetBytes: 750 * 1024 * 1024,
  maxQueuedJobs: 1000,
  maxRetryAttempts: 15,
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
  eventHandler: CaptureHelperEventHandler;
  lifecycle: CaptureLifecycle;
  commandClient: CaptureHelperCommandClient;
};

export function createCaptureRuntime(options: CaptureRuntimeOptions): CaptureRuntime {
  const rawEventHandler = createCaptureHelperEventHandler({
    backpressure: options.backpressure ?? DEFAULT_BACKPRESSURE,
    client: options.client,
    deviceId: options.deviceId,
    now: options.now,
    store: options.store,
    workspaceId: options.workspaceId,
  });
  const eventHandler = decorateEventHandler(rawEventHandler, options.onHelperEnvelope);
  const helper = createCaptureHelperController({
    client: options.client,
    deviceId: options.deviceId,
    eventHandler,
    now: options.now,
    policyActivation: createCapturePolicyActivation({
      api: options.policyApi,
      deviceId: options.deviceId,
      now: options.now,
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
    startupRecovery: options.startupRecovery,
  });

  return { commandClient: options.client, eventHandler, lifecycle };
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
