import type {
  AssetAvailabilityState,
  AssetCacheRef,
  OperationalStoreRepository,
  OutboxJob,
  SafeOperationalError,
} from './types';

export type AssetAvailabilityCheck = {
  availabilityState: AssetAvailabilityState;
  availabilitySafeError?: SafeOperationalError;
};

export type AssetAvailabilityResolver = {
  checkAvailability(asset: AssetCacheRef): Promise<AssetAvailabilityCheck>;
};

export type AssetReconciliationOptions = {
  store: OperationalStoreRepository;
  resolver: AssetAvailabilityResolver;
  now: string;
  workspaceId?: string;
};

export type AssetReconciliationSummary = {
  checked: number;
  available: number;
  missing: number;
  unreadable: number;
  blocked: number;
  skippedTerminal: number;
  skippedServerPolling: number;
};

const TERMINAL_OUTBOX_STATES = new Set<OutboxJob['state']>([
  'synced',
  'blocked',
  'failed',
  'cancelled',
]);

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

export async function reconcileAssetRefs(
  options: AssetReconciliationOptions,
): Promise<AssetReconciliationSummary> {
  const assets = await options.store.listAssetCacheRefs(options.workspaceId);
  const jobs = await options.store.listOutboxJobs(
    options.workspaceId ? { workspaceId: options.workspaceId } : undefined,
  );
  const jobsByAssetRef = groupJobsByAssetRef(jobs);
  const summary: AssetReconciliationSummary = {
    available: 0,
    blocked: 0,
    checked: assets.length,
    missing: 0,
    skippedServerPolling: 0,
    skippedTerminal: 0,
    unreadable: 0,
  };

  for (const asset of assets) {
    const check = await checkAvailability(options.resolver, asset);
    incrementAvailability(summary, check.availabilityState);

    const availabilitySafeError =
      check.availabilityState === 'available'
        ? undefined
        : (check.availabilitySafeError ?? defaultAvailabilityError(check.availabilityState));

    await updateAvailability(options, asset, check.availabilityState, availabilitySafeError);

    if (check.availabilityState === 'available') {
      continue;
    }

    const blockingError =
      availabilitySafeError ?? defaultAvailabilityError(check.availabilityState);

    for (const job of jobsByAssetRef.get(asset.assetRefId) ?? []) {
      if (TERMINAL_OUTBOX_STATES.has(job.state)) {
        summary.skippedTerminal += 1;
        continue;
      }

      if (hasServerOcrPollingPath(job)) {
        summary.skippedServerPolling += 1;
        continue;
      }

      if (!requiresLocalAssetBytes(job)) {
        continue;
      }

      const result = await options.store.markOutboxJobTerminal(job.id, {
        lastSafeError: blockingError,
        now: options.now,
        reason: blockingError.code,
        serverCaptureId: job.serverCaptureId,
        serverOcrJobId: job.serverOcrJobId,
        state: 'blocked',
      });

      if (!result.ok && result.error.code !== 'terminal_state_conflict') {
        throw new Error(`Asset reconciliation failed for outbox job: ${result.error.code}`);
      }

      if (result.ok) {
        summary.blocked += 1;
      } else {
        summary.skippedTerminal += 1;
      }
    }
  }

  return summary;
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
  options: AssetReconciliationOptions,
  asset: AssetCacheRef,
  availabilityState: AssetAvailabilityState,
  availabilitySafeError: SafeOperationalError | undefined,
): Promise<void> {
  const result = await options.store.updateAssetRefAvailability({
    assetRefId: asset.assetRefId,
    availabilitySafeError,
    availabilityState,
    now: options.now,
  });

  if (!result.ok) {
    throw new Error(`Asset reconciliation failed for asset ref: ${result.error.code}`);
  }
}

function requiresLocalAssetBytes(job: OutboxJob): boolean {
  if (
    job.capture.privacyDecision.action === 'block_capture' ||
    job.capture.privacyDecision.action === 'block_ocr'
  ) {
    return false;
  }

  return job.state === 'pending' || job.state === 'uploading' || job.state === 'ocr_wait';
}

function hasServerOcrPollingPath(job: OutboxJob): boolean {
  return Boolean(job.serverOcrJobId) && (job.state === 'pending' || job.state === 'ocr_wait');
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

function groupJobsByAssetRef(jobs: OutboxJob[]): Map<string, OutboxJob[]> {
  const grouped = new Map<string, OutboxJob[]>();

  for (const job of jobs) {
    const jobsForAsset = grouped.get(job.assetRefId) ?? [];
    jobsForAsset.push(job);
    grouped.set(job.assetRefId, jobsForAsset);
  }

  return grouped;
}

function incrementAvailability(
  summary: AssetReconciliationSummary,
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
