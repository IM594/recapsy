import type { SyncRunResult } from './types';

export type SyncGateReason = 'provider_auth_failed' | 'provider_configuration_invalid';
export type SyncGateState = 'open' | 'paused' | 'half_open';

export type SyncGateStatus =
  | { state: 'open' }
  | {
      state: Exclude<SyncGateState, 'open'>;
      reason: SyncGateReason;
      pausedAt: string;
      nextProbeAt: string;
    };

export type SyncGate = {
  getStatus(): SyncGateStatus;
  observe(result: SyncRunResult, now: string): void;
  pause(reason: SyncGateReason, now: string): void;
  resume(): void;
  tryEnter(now: string): boolean;
};

export type SyncGateOptions = {
  probeDelayMs?: number;
};

const DEFAULT_PROBE_DELAY_MS = 60_000;

export function createSyncGate(options: SyncGateOptions = {}): SyncGate {
  const probeDelayMs = positiveInteger(options.probeDelayMs, DEFAULT_PROBE_DELAY_MS);
  let status: SyncGateStatus = { state: 'open' };

  function open(): void {
    status = { state: 'open' };
  }

  function pause(reason: SyncGateReason, now: string): void {
    status = {
      nextProbeAt: new Date(Date.parse(now) + probeDelayMs).toISOString(),
      pausedAt: now,
      reason,
      state: 'paused',
    };
  }

  return {
    getStatus() {
      return { ...status };
    },
    observe(result, now) {
      if (
        result.code === 'provider_auth_failed' ||
        result.code === 'provider_configuration_invalid'
      ) {
        if (status.state !== 'paused') {
          pause(result.code, now);
        }
        return;
      }
      if (status.state === 'half_open' && result.providerOutcome === 'succeeded') {
        open();
        return;
      }
      if (status.state === 'half_open') {
        pause(status.reason, now);
      }
    },
    pause,
    resume: open,
    tryEnter(now) {
      if (status.state === 'open') {
        return true;
      }
      if (status.state === 'half_open' || now < status.nextProbeAt) {
        return false;
      }
      status = { ...status, state: 'half_open' };
      return true;
    },
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}
