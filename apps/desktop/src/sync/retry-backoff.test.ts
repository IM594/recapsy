import { describe, expect, it } from 'bun:test';
import { computeRetryBackoffDelayMs } from './scheduler';
import type { RetryBackoffConfig } from './types';

const CONFIG: RetryBackoffConfig = {
  baseMs: 2000,
  factor: 2,
  jitterRatio: 0.2,
  maxMs: 300_000,
};

/** Jitter source pinned to the midpoint so the ± jitter offset is exactly zero. */
const noJitter = () => 0.5;

describe('computeRetryBackoffDelayMs', () => {
  it('grows exponentially from baseMs on the first attempt (attempt 0)', () => {
    expect(computeRetryBackoffDelayMs(CONFIG, 0, noJitter)).toBe(2000);
    expect(computeRetryBackoffDelayMs(CONFIG, 1, noJitter)).toBe(4000);
    expect(computeRetryBackoffDelayMs(CONFIG, 2, noJitter)).toBe(8000);
    expect(computeRetryBackoffDelayMs(CONFIG, 3, noJitter)).toBe(16_000);
  });

  it('caps the exponential term at maxMs before jitter', () => {
    // 2000 * 2^8 = 512_000 > 300_000, so it is clamped.
    expect(computeRetryBackoffDelayMs(CONFIG, 8, noJitter)).toBe(300_000);
    expect(computeRetryBackoffDelayMs(CONFIG, 20, noJitter)).toBe(300_000);
  });

  it('applies symmetric jitter spanning ±jitterRatio of the capped delay', () => {
    // attempt 2 → capped 8000, jitterSpan = 8000 * 0.2 = 1600.
    expect(computeRetryBackoffDelayMs(CONFIG, 2, () => 0)).toBe(8000 - 1600);
    expect(computeRetryBackoffDelayMs(CONFIG, 2, () => 1)).toBe(8000 + 1600);
    expect(computeRetryBackoffDelayMs(CONFIG, 2, () => 0.75)).toBe(8000 + 800);
  });

  it('keeps a randomized delay within the jitter band for every random draw', () => {
    const attempt = 4; // capped 32_000, span 6400 → [25_600, 38_400].
    for (let i = 0; i <= 20; i += 1) {
      const delay = computeRetryBackoffDelayMs(CONFIG, attempt, () => i / 20);
      expect(delay).toBeGreaterThanOrEqual(25_600);
      expect(delay).toBeLessThanOrEqual(38_400);
    }
  });

  it('never returns a negative delay even with an extreme jitter ratio', () => {
    const wideJitter: RetryBackoffConfig = { ...CONFIG, jitterRatio: 2 };
    expect(computeRetryBackoffDelayMs(wideJitter, 0, () => 0)).toBe(0);
  });

  it('reduces to a flat delay when jitterRatio is zero', () => {
    const flat: RetryBackoffConfig = { ...CONFIG, jitterRatio: 0 };
    expect(computeRetryBackoffDelayMs(flat, 0, Math.random)).toBe(2000);
    expect(computeRetryBackoffDelayMs(flat, 1, Math.random)).toBe(4000);
  });
});
