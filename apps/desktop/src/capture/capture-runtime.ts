import type { HelperEnvelope, HelperToMainType } from '../helper/public';
import type { CaptureHelperClient } from '../helper/public';
import type { DesktopRuntime } from '../runtime/public';
import { createDesktopRuntime } from '../runtime/public';
import {
  type AssetAvailabilityResolver,
  type BackpressureConfig,
  type OperationalStoreRepository,
  reconcileAssetRefs,
} from '../storage/public';
import { createCaptureHelperController } from './capture-helper-controller';
import {
  type CaptureHelperCommandClient,
  type CaptureHelperEventIntake,
  createCaptureHelperEventIntake,
} from './capture-helper-event-intake';

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

export type CaptureStartupRecovery = {
  recover(): Promise<void>;
};

export type CaptureRuntimeOptions = {
  assetResolver?: AssetAvailabilityResolver;
  backpressure?: BackpressureConfig;
  client: CaptureHelperClient & CaptureHelperCommandClient;
  deviceId: string;
  now(): string;
  onHelperEnvelope?(envelope: HelperEnvelope<HelperToMainType>): void;
  startupRecovery: CaptureStartupRecovery;
  store: OperationalStoreRepository;
  workspaceId: string;
};

export type CaptureRuntime = {
  eventIntake: CaptureHelperEventIntake;
  runtime: DesktopRuntime;
};

export function createCaptureRuntime(options: CaptureRuntimeOptions): CaptureRuntime {
  const rawEventIntake = createCaptureHelperEventIntake({
    backpressure: options.backpressure ?? DEFAULT_BACKPRESSURE,
    client: options.client,
    deviceId: options.deviceId,
    now: options.now,
    store: options.store,
    workspaceId: options.workspaceId,
  });
  const eventIntake = decorateEventIntake(rawEventIntake, options.onHelperEnvelope);
  const helper = createCaptureHelperController({
    client: options.client,
    deviceId: options.deviceId,
    eventIntake,
    now: options.now,
    store: options.store,
  });
  const runtime = createDesktopRuntime({
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

  return { eventIntake, runtime };
}

function decorateEventIntake(
  eventIntake: CaptureHelperEventIntake,
  onHelperEnvelope: CaptureRuntimeOptions['onHelperEnvelope'],
): CaptureHelperEventIntake {
  if (!onHelperEnvelope) {
    return eventIntake;
  }

  return {
    getStatus: () => eventIntake.getStatus(),
    async handleEnvelope(envelope) {
      onHelperEnvelope(envelope);
      await eventIntake.handleEnvelope(envelope);
    },
    handleProtocolResult: (result) => eventIntake.handleProtocolResult(result),
  };
}
