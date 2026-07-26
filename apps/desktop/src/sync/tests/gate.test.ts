import { describe, expect, it } from 'bun:test';
import { createSyncGate } from '../gate';

const startedAt = '2026-07-27T00:00:00.000Z';

describe('sync provider gate', () => {
  it('pauses after provider authentication fails and allows one probe after the cooldown', () => {
    const gate = createSyncGate({ probeDelayMs: 60_000 });

    gate.pause('provider_auth_failed', startedAt);

    expect(gate.getStatus()).toEqual({
      nextProbeAt: '2026-07-27T00:01:00.000Z',
      pausedAt: startedAt,
      reason: 'provider_auth_failed',
      state: 'paused',
    });
    expect(gate.tryEnter('2026-07-27T00:00:59.999Z')).toBe(false);
    expect(gate.tryEnter('2026-07-27T00:01:00.000Z')).toBe(true);
    expect(gate.getStatus().state).toBe('half_open');
    expect(gate.tryEnter('2026-07-27T00:01:00.001Z')).toBe(false);
  });

  it('restarts the cooldown after a failed probe and opens after provider success', () => {
    const gate = createSyncGate({ probeDelayMs: 60_000 });
    gate.pause('provider_auth_failed', startedAt);
    expect(gate.tryEnter('2026-07-27T00:01:00.000Z')).toBe(true);

    gate.observe(
      { code: 'provider_auth_failed', processed: 1, status: 'retry_wait' },
      '2026-07-27T00:01:05.000Z',
    );
    expect(gate.getStatus()).toMatchObject({
      nextProbeAt: '2026-07-27T00:02:05.000Z',
      state: 'paused',
    });
    expect(gate.tryEnter('2026-07-27T00:02:05.000Z')).toBe(true);

    gate.observe(
      { processed: 1, providerOutcome: 'succeeded', status: 'synced' },
      '2026-07-27T00:02:10.000Z',
    );
    expect(gate.getStatus()).toEqual({ state: 'open' });
    expect(gate.tryEnter('2026-07-27T00:02:10.001Z')).toBe(true);
  });

  it('does not extend the cooldown when the same authentication failure is observed twice', () => {
    const gate = createSyncGate({ probeDelayMs: 60_000 });
    const failure = {
      code: 'provider_auth_failed' as const,
      processed: 1,
      status: 'retry_wait' as const,
    };

    gate.observe(failure, startedAt);
    gate.observe(failure, '2026-07-27T00:00:05.000Z');

    expect(gate.getStatus()).toEqual({
      nextProbeAt: '2026-07-27T00:01:00.000Z',
      pausedAt: startedAt,
      reason: 'provider_auth_failed',
      state: 'paused',
    });
  });

  it('supports an explicit resume without reusing stale pause metadata', () => {
    const gate = createSyncGate({ probeDelayMs: 60_000 });
    gate.pause('provider_auth_failed', startedAt);

    gate.resume();

    expect(gate.getStatus()).toEqual({ state: 'open' });
    expect(gate.tryEnter('2026-07-27T00:00:01.000Z')).toBe(true);
  });
});
