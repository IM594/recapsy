import type {
  AssetCacheRef,
  OperationalStoreResult,
  OutboxJob,
  OutboxJobListFilter,
  RecoverPendingAssetCleanupInput,
  SetAssetCleanupStateInput,
} from './types';

export type LocalRetentionDryRun = {
  cutoffAt: string;
  eligibleAssets: number;
  evaluatedAssets: number;
  olderThanDays: number;
  protectedAssets: number;
  reclaimableBytes: number;
};

export type LocalRetentionDryRunStore = {
  listAssetCacheRefs(workspaceId?: string): Promise<AssetCacheRef[]>;
  listOutboxJobs(filter?: OutboxJobListFilter): Promise<OutboxJob[]>;
};

export type LocalRetentionDryRunOptions = {
  now: string;
  olderThanDays: number;
  store: LocalRetentionDryRunStore;
  workspaceId: string;
};

export type LocalRetentionExecution = {
  cleanedAssets: number;
  failedAssets: number;
  protectedAssets: number;
  reclaimedBytes: number;
  retriedInterruptedAssets: number;
};

export type LocalRetentionExecutionStore = LocalRetentionDryRunStore & {
  claimAssetCleanup(input: { assetRefId: string; now: string }): Promise<AssetCacheRef | null>;
  recoverPendingAssetCleanup(input: RecoverPendingAssetCleanupInput): Promise<number>;
  settleAssetCleanup(
    input: SetAssetCleanupStateInput,
  ): Promise<OperationalStoreResult<AssetCacheRef>>;
};

export type LocalRetentionExecutionOptions = {
  now: string;
  olderThanDays: number;
  removeAsset(localAccessKey: string): Promise<void>;
  store: LocalRetentionExecutionStore;
  workspaceId: string;
};

/**
 * Produces a conservative, read-only cleanup preview. The explicit cleanup
 * action uses the same eligibility predicate, so review and execution cannot
 * drift apart.
 */
export async function planLocalRetentionDryRun(
  options: LocalRetentionDryRunOptions,
): Promise<LocalRetentionDryRun> {
  const cutoffAt = cutoffFor(options.now, options.olderThanDays);
  const [assets, jobs] = await Promise.all([
    options.store.listAssetCacheRefs(options.workspaceId),
    options.store.listOutboxJobs({ workspaceId: options.workspaceId }),
  ]);
  const jobsByAsset = groupJobsByAsset(jobs);
  let eligibleAssets = 0;
  let reclaimableBytes = 0;

  for (const asset of assets) {
    if (isEligibleForCleanup(asset, jobsByAsset.get(asset.assetRefId) ?? [], cutoffAt)) {
      eligibleAssets += 1;
      reclaimableBytes += asset.sizeBytes;
    }
  }

  return {
    cutoffAt,
    eligibleAssets,
    evaluatedAssets: assets.length,
    olderThanDays: options.olderThanDays,
    protectedAssets: assets.length - eligibleAssets,
    reclaimableBytes,
  };
}

/**
 * Deletes only assets that the same conservative preview would permit. Every
 * attempt first persists `cleanup_pending`; completion or failure then remains
 * inspectable on the asset reference. A prior pending state means the process
 * stopped between those writes, so it is retried on the next explicit run.
 */
export async function executeLocalRetention(
  options: LocalRetentionExecutionOptions,
): Promise<LocalRetentionExecution> {
  const cutoffAt = cutoffFor(options.now, options.olderThanDays);
  const retriedInterruptedAssets = await options.store.recoverPendingAssetCleanup({
    now: options.now,
    workspaceId: options.workspaceId,
  });
  const [assets, jobs] = await Promise.all([
    options.store.listAssetCacheRefs(options.workspaceId),
    options.store.listOutboxJobs({ workspaceId: options.workspaceId }),
  ]);
  const jobsByAsset = groupJobsByAsset(jobs);
  let cleanedAssets = 0;
  let failedAssets = 0;
  let reclaimedBytes = 0;
  let eligibleAssets = 0;

  for (const asset of assets) {
    if (!isEligibleForCleanup(asset, jobsByAsset.get(asset.assetRefId) ?? [], cutoffAt)) {
      continue;
    }
    eligibleAssets += 1;
    const claimed = await options.store.claimAssetCleanup({
      assetRefId: asset.assetRefId,
      now: options.now,
    });
    if (!claimed) {
      continue;
    }

    try {
      await options.removeAsset(claimed.localAccessKey);
      const settled = await options.store.settleAssetCleanup({
        assetRefId: claimed.assetRefId,
        cleanupState: 'cleaned',
        now: options.now,
      });
      if (!settled.ok) {
        failedAssets += 1;
        continue;
      }
      cleanedAssets += 1;
      reclaimedBytes += claimed.sizeBytes;
    } catch {
      await options.store.settleAssetCleanup({
        assetRefId: claimed.assetRefId,
        cleanupSafeError: LOCAL_ASSET_CLEANUP_FAILED,
        cleanupState: 'cleanup_failed',
        now: options.now,
      });
      failedAssets += 1;
    }
  }

  return {
    cleanedAssets,
    failedAssets,
    protectedAssets: assets.length - eligibleAssets,
    reclaimedBytes,
    retriedInterruptedAssets,
  };
}

const LOCAL_ASSET_CLEANUP_FAILED = {
  code: 'local_asset_cleanup_failed',
  message: 'Local asset cleanup failed.',
  retryable: true,
} as const;

function cutoffFor(now: string, olderThanDays: number): string {
  if (!Number.isInteger(olderThanDays) || olderThanDays < 1) {
    throw new Error('Retention preview requires a positive whole number of days.');
  }

  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) {
    throw new Error('Retention preview requires a valid current time.');
  }

  return new Date(timestamp - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
}

function groupJobsByAsset(jobs: readonly OutboxJob[]): Map<string, OutboxJob[]> {
  const jobsByAsset = new Map<string, OutboxJob[]>();
  for (const job of jobs) {
    const existing = jobsByAsset.get(job.assetRefId) ?? [];
    existing.push(job);
    jobsByAsset.set(job.assetRefId, existing);
  }
  return jobsByAsset;
}

function isEligibleForCleanup(
  asset: AssetCacheRef,
  jobs: readonly OutboxJob[],
  cutoffAt: string,
): boolean {
  return (
    (asset.cleanupState === 'retained' || asset.cleanupState === 'cleanup_failed') &&
    asset.availabilityState === 'available' &&
    asset.createdAt < cutoffAt &&
    jobs.length > 0 &&
    jobs.every((job) => job.state === 'synced')
  );
}
