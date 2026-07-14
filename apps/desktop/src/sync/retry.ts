import type { RetryBackoffConfig, RetryJitterSource } from './types';

/**
 * Exponential backoff with symmetric jitter: `min(maxMs, baseMs * factor^attempt)`,
 * then spread by ± `jitterRatio` to de-synchronize concurrent retries across
 * jobs and devices (see `docs/design/OCR_OUTBOX_STATE_MACHINE.md` §4.2). `attempt`
 * is the job's already-consumed retry count — the store increments it when it
 * records the error, so a freshly claimed job on its first failure has
 * `attempt === 0` and waits `baseMs`.
 */
export function computeRetryBackoffDelayMs(
  config: RetryBackoffConfig,
  attempt: number,
  jitterRandom: RetryJitterSource,
): number {
  const exponential = config.baseMs * config.factor ** attempt;
  const capped = Math.min(config.maxMs, exponential);
  const jitterSpan = capped * config.jitterRatio;
  const jitterOffset = jitterSpan * (jitterRandom() * 2 - 1);
  return Math.max(0, Math.round(capped + jitterOffset));
}
