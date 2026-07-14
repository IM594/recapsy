import type { HelperEnvelope, HelperToMainType } from '../helper/public';
import type { CaptureHelperClient } from '../helper/public';
import {
  type AssetAvailabilityResolver,
  type AssetReconciliationStore,
  type BackpressureConfig,
  reconcileAssetRefs,
} from '../storage/public';
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
import type { CaptureIntakeStore, HelperStateStore } from './store';

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

export type CaptureRuntimeStore = CaptureIntakeStore & HelperStateStore & AssetReconciliationStore;

export type CaptureRuntimeOptions = {
  assetResolver?: AssetAvailabilityResolver;
  backpressure?: BackpressureConfig;
  client: CaptureHelperClient & CaptureHelperCommandClient;
  deviceId: string;
  now(): string;
  onHelperEnvelope?(envelope: HelperEnvelope<HelperToMainType>): void;
  startupRecovery: CaptureStartupRecovery;
  store: CaptureRuntimeStore;
  workspaceId: string;
};

export type CaptureRuntime = {
  eventHandler: CaptureHelperEventHandler;
  lifecycle: CaptureLifecycle;
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

  return { eventHandler, lifecycle };
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
    async handleEnvelope(envelope) {
      onHelperEnvelope(envelope);
      await eventHandler.handleEnvelope(envelope);
    },
    handleProtocolResult: (result) => eventHandler.handleProtocolResult(result),
  };
}
