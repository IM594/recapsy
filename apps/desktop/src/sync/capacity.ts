import type { SyncRunResult } from './types';

export type SyncWorkerCapacityStatus = {
  activeWorkers: number;
  localMaxWorkers: number;
  serverMaxConcurrentOcr: number;
};

export type SyncWorkerCapacityChange = {
  activeWorkers: number;
  changed: boolean;
};

export type SyncWorkerCapacity = {
  getStatus(): SyncWorkerCapacityStatus;
  observe(result: SyncRunResult): SyncWorkerCapacityChange;
  updateServerMaxConcurrentOcr(value: number): SyncWorkerCapacityChange;
};

export type SyncWorkerCapacityOptions = {
  localMaxWorkers: number;
  recoverySuccesses?: number;
  serverMaxConcurrentOcr: number;
};

/**
 * Converts a server-declared OCR ceiling into the number of local serial
 * workers. The server remains authoritative; the local limit only protects
 * this device. A rate-limit halves the active budget, while successful work
 * earns one worker back after a short, deterministic recovery window.
 */
export function createSyncWorkerCapacity(options: SyncWorkerCapacityOptions): SyncWorkerCapacity {
  const localMaxWorkers = positiveInteger(options.localMaxWorkers, 1);
  let serverMaxConcurrentOcr = positiveInteger(options.serverMaxConcurrentOcr, 1);
  let ceiling = Math.min(localMaxWorkers, serverMaxConcurrentOcr);
  const recoverySuccesses = positiveInteger(options.recoverySuccesses, 3);
  let activeWorkers = ceiling;
  let consecutiveSuccesses = 0;

  return {
    getStatus() {
      return {
        activeWorkers,
        localMaxWorkers,
        serverMaxConcurrentOcr,
      };
    },
    observe(result) {
      if (result.code === 'provider_rate_limited') {
        const next = Math.max(1, Math.floor(activeWorkers / 2));
        const changed = next !== activeWorkers;
        activeWorkers = next;
        consecutiveSuccesses = 0;
        return { activeWorkers, changed };
      }

      if (
        result.providerOutcome === 'succeeded' &&
        result.status === 'synced' &&
        result.processed > 0 &&
        activeWorkers < ceiling
      ) {
        consecutiveSuccesses += 1;
        if (consecutiveSuccesses >= recoverySuccesses) {
          activeWorkers += 1;
          consecutiveSuccesses = 0;
          return { activeWorkers, changed: true };
        }
      } else if (result.status !== 'synced') {
        consecutiveSuccesses = 0;
      }

      return { activeWorkers, changed: false };
    },
    updateServerMaxConcurrentOcr(value) {
      serverMaxConcurrentOcr = positiveInteger(value, 1);
      ceiling = Math.min(localMaxWorkers, serverMaxConcurrentOcr);
      const nextActiveWorkers = Math.min(activeWorkers, ceiling);
      const changed = nextActiveWorkers !== activeWorkers;
      activeWorkers = nextActiveWorkers;
      consecutiveSuccesses = 0;
      return { activeWorkers, changed };
    },
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}
