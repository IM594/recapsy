import type {
  AssetAvailabilityState,
  AssetCacheRef,
  OperationalStoreResult,
  OutboxJob,
  OutboxTerminalUpdate,
  SafeOperationalError,
  ServerCaptureSettlement,
  ServerCaptureSettlementInput,
  UpdateAssetRefAvailabilityInput,
} from './types';

export type AssetAvailabilityCheck = {
  availabilityState: AssetAvailabilityState;
  availabilitySafeError?: SafeOperationalError;
};

export type AssetAvailabilityResolver = {
  checkAvailability(asset: AssetCacheRef): Promise<AssetAvailabilityCheck>;
};

export type ActiveAssetRefDependency = {
  asset: AssetCacheRef;
  jobs: OutboxJob[];
};

export type HistoricalAssetRefPageInput = {
  afterAssetRefId?: string;
  limit: number;
  workspaceId?: string;
};

export type AssetReconciliationStore = {
  listActiveAssetRefDependencies(workspaceId?: string): Promise<ActiveAssetRefDependency[]>;
  listHistoricalAssetRefPage(input: HistoricalAssetRefPageInput): Promise<AssetCacheRef[]>;
  updateAssetRefAvailability(
    input: UpdateAssetRefAvailabilityInput,
  ): Promise<OperationalStoreResult<AssetCacheRef>>;
  markOutboxJobTerminal(
    id: string,
    update: OutboxTerminalUpdate,
  ): Promise<OperationalStoreResult<OutboxJob>>;
};

export type ActiveAssetReconciliationOptions = {
  store: AssetReconciliationStore;
  resolver: AssetAvailabilityResolver;
  now: string;
  workspaceId?: string;
};

export type ActiveAssetReconciliationSummary = {
  checked: number;
  available: number;
  missing: number;
  unreadable: number;
  blocked: number;
};

export type HistoricalAssetReconciliationOptions = {
  availabilityCheckAfterMs?: number;
  now(): string;
  pageSize?: number;
  resolver: AssetAvailabilityResolver;
  store: AssetReconciliationStore;
  workspaceId?: string;
};

export type HistoricalAssetReconciliation = {
  start(): void;
  stop(): Promise<void>;
};

export type ServerCaptureSettlementStore = {
  getOutboxJob(id: string): Promise<OutboxJob | null>;
  markOutboxJobTerminal(
    id: string,
    update: OutboxTerminalUpdate,
  ): Promise<OperationalStoreResult<OutboxJob>>;
};

const LOCAL_ASSET_MISSING_ERROR = {
  code: 'local_asset_missing',
  message: 'Local asset is missing.',
  retryable: false,
} satisfies SafeOperationalError;

const LOCAL_ASSET_UNREADABLE_ERROR = {
  code: 'local_asset_unreadable',
  message: 'Local asset is unreadable.',
  retryable: false,
} satisfies SafeOperationalError;

const DEFAULT_AVAILABILITY_RECHECK_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HISTORICAL_PAGE_SIZE = 32;

export async function reconcileActiveAssetRefs(
  options: ActiveAssetReconciliationOptions,
): Promise<ActiveAssetReconciliationSummary> {
  const dependencies = await options.store.listActiveAssetRefDependencies(options.workspaceId);
  const summary: ActiveAssetReconciliationSummary = {
    available: 0,
    blocked: 0,
    checked: 0,
    missing: 0,
    unreadable: 0,
  };

  for (const { asset, jobs } of dependencies) {
    const check = await checkAvailability(options.resolver, asset);
    summary.checked += 1;
    incrementAvailability(summary, check.availabilityState);

    const availabilitySafeError =
      check.availabilityState === 'available'
        ? undefined
        : (check.availabilitySafeError ?? defaultAvailabilityError(check.availabilityState));

    await updateAvailability(
      options.store,
      options.now,
      asset,
      check.availabilityState,
      availabilitySafeError,
    );

    if (check.availabilityState === 'available') {
      continue;
    }

    const blockingError =
      availabilitySafeError ?? defaultAvailabilityError(check.availabilityState);

    for (const job of jobs) {
      const result = await options.store.markOutboxJobTerminal(job.id, {
        lastSafeError: blockingError,
        leaseToken: job.leaseToken,
        now: options.now,
        reason: blockingError.code,
        serverCaptureId: job.serverCaptureId,
        state: 'blocked',
      });

      if (!result.ok && result.error.code !== 'terminal_state_conflict') {
        throw new Error(`Asset reconciliation failed for outbox job: ${result.error.code}`);
      }

      if (result.ok) {
        summary.blocked += 1;
      }
    }
  }

  return summary;
}

export function createHistoricalAssetReconciliation(
  options: HistoricalAssetReconciliationOptions,
): HistoricalAssetReconciliation {
  const pageSize = positiveInteger(options.pageSize, DEFAULT_HISTORICAL_PAGE_SIZE);
  let acceptingWrites = false;
  let generation = 0;
  let inFlight: Promise<void> | undefined;
  let inFlightGeneration: number | undefined;
  let restartPending = false;

  const isCurrent = (candidate: number) => acceptingWrites && candidate === generation;

  function launch(): void {
    const runGeneration = ++generation;
    const run = sweepHistoricalAssetRefs(options, pageSize, () => isCurrent(runGeneration))
      .catch(() => undefined)
      .finally(() => {
        if (inFlightGeneration !== runGeneration) {
          return;
        }

        inFlight = undefined;
        inFlightGeneration = undefined;
        if (acceptingWrites && restartPending) {
          restartPending = false;
          launch();
        }
      });
    inFlight = run;
    inFlightGeneration = runGeneration;
  }

  return {
    start() {
      if (acceptingWrites) {
        return;
      }

      acceptingWrites = true;
      if (inFlight) {
        restartPending = true;
        return;
      }

      launch();
    },
    async stop() {
      acceptingWrites = false;
      generation += 1;
      restartPending = false;
      await inFlight;
    },
  };
}

async function sweepHistoricalAssetRefs(
  options: HistoricalAssetReconciliationOptions,
  pageSize: number,
  isCurrent: () => boolean,
): Promise<void> {
  let afterAssetRefId: string | undefined;

  while (isCurrent()) {
    const page = await options.store.listHistoricalAssetRefPage({
      afterAssetRefId,
      limit: pageSize,
      workspaceId: options.workspaceId,
    });
    if (!isCurrent() || page.length === 0) {
      return;
    }

    const now = options.now();
    for (const asset of page) {
      if (!shouldCheckHistoricalAvailability(asset, now, options.availabilityCheckAfterMs)) {
        continue;
      }

      const check = await checkAvailability(options.resolver, asset);
      if (!isCurrent()) {
        return;
      }

      const availabilitySafeError =
        check.availabilityState === 'available'
          ? undefined
          : (check.availabilitySafeError ?? defaultAvailabilityError(check.availabilityState));
      await updateAvailability(
        options.store,
        now,
        asset,
        check.availabilityState,
        availabilitySafeError,
      );
    }

    if (page.length < pageSize) {
      return;
    }

    afterAssetRefId = page[page.length - 1]?.assetRefId;
  }
}

function shouldCheckHistoricalAvailability(
  asset: AssetCacheRef,
  now: string,
  availabilityCheckAfterMs?: number,
): boolean {
  if (asset.availabilityState !== 'available' || !asset.availabilityCheckedAt) {
    return true;
  }

  const checkedAt = Date.parse(asset.availabilityCheckedAt);
  const currentTime = Date.parse(now);
  if (!Number.isFinite(checkedAt) || !Number.isFinite(currentTime)) {
    return true;
  }
  return currentTime - checkedAt >= (availabilityCheckAfterMs ?? DEFAULT_AVAILABILITY_RECHECK_MS);
}

export async function settleServerCapture(
  store: ServerCaptureSettlementStore,
  input: ServerCaptureSettlementInput,
): Promise<ServerCaptureSettlement> {
  const terminal = await store.markOutboxJobTerminal(input.id, {
    leaseToken: input.leaseToken,
    now: input.now,
    reason: 'ocr_synced',
    serverCaptureId: input.serverCaptureId,
    state: 'synced',
  });

  if (terminal.ok) {
    return { status: 'synced' };
  }

  const current = await store.getOutboxJob(input.id);
  if (current?.state === 'synced' && current.serverCaptureId === input.serverCaptureId) {
    return { status: 'synced' };
  }

  return {
    ...(terminal.error.code === 'outbox_lease_lost' ? { code: 'lease_lost' as const } : {}),
    status: 'skipped',
  };
}

async function checkAvailability(
  resolver: AssetAvailabilityResolver,
  asset: AssetCacheRef,
): Promise<AssetAvailabilityCheck> {
  try {
    const check = await resolver.checkAvailability(asset);
    return {
      availabilitySafeError: sanitizeAvailabilityError(
        check.availabilitySafeError,
        check.availabilityState,
      ),
      availabilityState: check.availabilityState,
    };
  } catch {
    return {
      availabilitySafeError: LOCAL_ASSET_UNREADABLE_ERROR,
      availabilityState: 'unreadable',
    };
  }
}

async function updateAvailability(
  store: AssetReconciliationStore,
  now: string,
  asset: AssetCacheRef,
  availabilityState: AssetAvailabilityState,
  availabilitySafeError: SafeOperationalError | undefined,
): Promise<void> {
  const result = await store.updateAssetRefAvailability({
    assetRefId: asset.assetRefId,
    availabilitySafeError,
    availabilityState,
    now,
  });

  if (!result.ok) {
    throw new Error(`Asset reconciliation failed for asset ref: ${result.error.code}`);
  }
}

function defaultAvailabilityError(availabilityState: Exclude<AssetAvailabilityState, 'available'>) {
  return availabilityState === 'missing' ? LOCAL_ASSET_MISSING_ERROR : LOCAL_ASSET_UNREADABLE_ERROR;
}

function sanitizeAvailabilityError(
  error: SafeOperationalError | undefined,
  availabilityState: AssetAvailabilityState,
): SafeOperationalError | undefined {
  if (availabilityState === 'available') {
    return undefined;
  }

  const expected = defaultAvailabilityError(availabilityState);

  if (error?.code === expected.code) {
    return {
      code: expected.code,
      message: expected.message,
      retryable: false,
    };
  }

  return expected;
}

function incrementAvailability(
  summary: ActiveAssetReconciliationSummary,
  availabilityState: AssetAvailabilityState,
): void {
  if (availabilityState === 'available') {
    summary.available += 1;
    return;
  }

  if (availabilityState === 'missing') {
    summary.missing += 1;
    return;
  }

  summary.unreadable += 1;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}
