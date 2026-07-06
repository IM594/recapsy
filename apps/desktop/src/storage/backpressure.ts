import type {
  BackpressureConfig,
  BackpressureDecision,
  BackpressureReason,
  OperationalStoreSnapshot,
} from './types';

export function evaluateOperationalStoreBackpressure(
  snapshot: OperationalStoreSnapshot,
  config: BackpressureConfig,
): BackpressureDecision {
  const reasons: BackpressureReason[] = [];

  if (snapshot.queuedJobs >= config.maxQueuedJobs) {
    reasons.push('max_queued_jobs_reached');
  }

  if (snapshot.assetBytes >= config.maxAssetBytes) {
    reasons.push('max_asset_bytes_reached');
  }

  if (snapshot.maxAttempt >= config.maxRetryAttempts) {
    reasons.push('max_retry_attempts_reached');
  }

  return {
    action: reasons.length > 0 ? 'pause' : 'allow',
    hardLimit: reasons.length > 0,
    reasons,
  };
}
