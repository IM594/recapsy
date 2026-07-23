import { describe, expect, it } from 'bun:test';
import { createSyncWorkerCapacity } from '../capacity';

describe('sync worker capacity', () => {
  it('uses the minimum of trusted server capacity and the local upper bound', () => {
    const capacity = createSyncWorkerCapacity({
      localMaxWorkers: 4,
      serverMaxConcurrentOcr: 2,
    });

    expect(capacity.getStatus()).toEqual({
      activeWorkers: 2,
      localMaxWorkers: 4,
      serverMaxConcurrentOcr: 2,
    });
  });

  it('does not reduce capacity on OCR concurrency backpressure', () => {
    const capacity = createSyncWorkerCapacity({
      localMaxWorkers: 4,
      serverMaxConcurrentOcr: 4,
    });

    expect(capacity.observe({ code: undefined, processed: 1, status: 'retry_wait' })).toEqual({
      activeWorkers: 4,
      changed: false,
    });

    // Concurrency-limited results are retryable but must not be observed as
    // provider_rate_limited, so capacity stays at the full ceiling.
    expect(capacity.getStatus().activeWorkers).toBe(4);
  });

  it('reduces capacity on provider rate limits and recovers gradually after successful work', () => {
    const capacity = createSyncWorkerCapacity({
      localMaxWorkers: 4,
      recoverySuccesses: 3,
      serverMaxConcurrentOcr: 4,
    });

    expect(
      capacity.observe({ code: 'provider_rate_limited', processed: 1, status: 'retry_wait' }),
    ).toEqual({ activeWorkers: 2, changed: true });
    expect(
      capacity.observe({ processed: 1, providerOutcome: 'succeeded', status: 'synced' }),
    ).toEqual({
      activeWorkers: 2,
      changed: false,
    });
    expect(
      capacity.observe({ processed: 1, providerOutcome: 'succeeded', status: 'synced' }),
    ).toEqual({
      activeWorkers: 2,
      changed: false,
    });
    expect(
      capacity.observe({ processed: 1, providerOutcome: 'succeeded', status: 'synced' }),
    ).toEqual({
      activeWorkers: 3,
      changed: true,
    });
  });

  it('never increases above the server limit or decreases below one worker', () => {
    const capacity = createSyncWorkerCapacity({
      localMaxWorkers: 8,
      recoverySuccesses: 1,
      serverMaxConcurrentOcr: 1,
    });

    expect(
      capacity.observe({ code: 'provider_rate_limited', processed: 1, status: 'retry_wait' }),
    ).toEqual({ activeWorkers: 1, changed: false });
    expect(
      capacity.observe({ processed: 1, providerOutcome: 'succeeded', status: 'synced' }),
    ).toEqual({
      activeWorkers: 1,
      changed: false,
    });
  });

  it('does not mistake metadata or result submission for a provider recovery signal', () => {
    const capacity = createSyncWorkerCapacity({
      localMaxWorkers: 4,
      recoverySuccesses: 1,
      serverMaxConcurrentOcr: 4,
    });

    capacity.observe({ code: 'provider_rate_limited', processed: 1, status: 'retry_wait' });

    expect(capacity.observe({ processed: 1, status: 'synced' })).toEqual({
      activeWorkers: 2,
      changed: false,
    });
    expect(
      capacity.observe({ processed: 1, providerOutcome: 'succeeded', status: 'synced' }),
    ).toEqual({
      activeWorkers: 3,
      changed: true,
    });
  });

  it('enforces a policy refresh that lowers the server ceiling immediately', () => {
    const capacity = createSyncWorkerCapacity({
      localMaxWorkers: 4,
      serverMaxConcurrentOcr: 4,
    });

    expect(capacity.updateServerMaxConcurrentOcr(1)).toEqual({ activeWorkers: 1, changed: true });
    expect(capacity.getStatus()).toEqual({
      activeWorkers: 1,
      localMaxWorkers: 4,
      serverMaxConcurrentOcr: 1,
    });
  });
});
