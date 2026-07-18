import type { AssetCacheRef, OutboxJob, OutboxJobListFilter } from './types';

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

/**
 * Produces a conservative, read-only cleanup preview. It intentionally never
 * marks or deletes files: only an explicit retention policy can authorize a
 * real cleanup worker in a later product increment.
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
    if (isEligibleForPreview(asset, jobsByAsset.get(asset.assetRefId) ?? [], cutoffAt)) {
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

function isEligibleForPreview(
  asset: AssetCacheRef,
  jobs: readonly OutboxJob[],
  cutoffAt: string,
): boolean {
  return (
    asset.cleanupState === 'retained' &&
    asset.availabilityState === 'available' &&
    asset.createdAt < cutoffAt &&
    jobs.length > 0 &&
    jobs.every((job) => job.state === 'synced')
  );
}
