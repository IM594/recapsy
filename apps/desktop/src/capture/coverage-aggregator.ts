import type { CaptureCoverageState } from '@recapsy/contracts';
import type { CoverageCloseReason } from '../storage/index';

export type { CoverageCloseReason };

// Pure run-length state machine for the capture-coverage spine. Holds no I/O:
// it only turns a stream of tick-level observations and control-plane
// signals into open/extend/close effects; the caller (see
// `capture/runtime.ts`) is responsible for persisting those effects through a
// `CaptureCoverageStore`. Kept side-effect-free so the state machine itself
// can be exercised with plain function calls, no fakes or async plumbing.
//
// Every tick produces exactly one of two facts: a frame was written
// (`observeCaptureResult`), or no frame was written and there is a reason
// (`observeCoverage`). A contiguous run of ticks sharing the same coverage
// state is one growing "open" segment; it closes — becoming an immutable,
// syncable row — whenever one of six things happens, each tracked as its own
// `CoverageCloseReason` (see `storage/types.ts`):
//   - `frame_captured`: a real frame arrived, ending the no-frame run.
//   - `state_changed`: the next tick's coverage state differs from the run's.
//   - `cadence_gap`: too much wall-clock time passed since the last tick
//     (helper stalled, machine slept, ...) to still call it the same run.
//   - `paused`: the control plane paused capture, ending whatever was open.
//   - `helper_exit`: the helper process is going away.
//   - `inferred_on_recovery`: reconstructed at startup from a hanging local
//     liveness row left behind by an ungraceful shutdown — not produced by
//     this module (see `storage/sqlite/coverage.ts`), listed here only
//     because it shares the same `CoverageCloseReason` vocabulary.

export type ClosedCoverageSegment = {
  coverageState: CaptureCoverageState;
  startedAt: string;
  endedAt: string;
  tickCount: number;
  intervalMs: number;
  closeReason: CoverageCloseReason;
};

export type OpenCoverageSegment = {
  coverageState: CaptureCoverageState;
  startedAt: string;
  tickCount: number;
  intervalMs: number;
};

export type CoverageAggregatorEffect =
  | ({ type: 'opened' } & Pick<OpenCoverageSegment, 'coverageState' | 'startedAt' | 'intervalMs'>)
  | ({ type: 'extended' } & Pick<OpenCoverageSegment, 'coverageState' | 'tickCount'> & {
        endedAt: string;
      })
  | { type: 'closed'; segment: ClosedCoverageSegment };

export type CoverageAggregatorOptions = {
  /**
   * A gap between two consecutive tick observations larger than this
   * multiple of the run's own `intervalMs` is treated as a cadence gap
   * (machine sleep, helper stall, ...) rather than a continuation of the
   * same run. Default 2 — generous enough to absorb normal scheduling
   * jitter without masking a real stall.
   */
  cadenceGapMultiplier?: number;
};

export type CoverageAggregator = {
  /** A tick produced no frame; `state` is why. */
  observeCoverage(input: {
    state: CaptureCoverageState;
    observedAt: string;
    intervalMs: number;
  }): CoverageAggregatorEffect[];
  /** A tick produced a frame, closing whatever no-frame run was open. */
  observeCaptureResult(input: { observedAt: string }): CoverageAggregatorEffect[];
  /**
   * Capture was paused by the control plane: closes whatever was open (with
   * `close_reason: 'paused'`) and opens a synthetic `paused` run. A no-op if
   * a `paused` run is already open.
   */
  pause(input: { observedAt: string; intervalMs: number }): CoverageAggregatorEffect[];
  /**
   * Capture resumed: closes an open `paused` run using the resume instant as
   * its end boundary. A no-op unless a `paused` run is open — the next real
   * tick observation closes and replaces any other open state on its own.
   */
  resume(input: { observedAt: string }): CoverageAggregatorEffect[];
  /** The helper process exited (or is being stopped); closes any open run. */
  handleHelperExit(input: { observedAt: string }): CoverageAggregatorEffect[];
  /** The current open run, if any — the "tail" a liveness upsert can report before it closes. */
  getOpenSegment(): OpenCoverageSegment | undefined;
};

const DEFAULT_CADENCE_GAP_MULTIPLIER = 2;

export function createCoverageAggregator(
  options: CoverageAggregatorOptions = {},
): CoverageAggregator {
  const cadenceGapMultiplier = options.cadenceGapMultiplier ?? DEFAULT_CADENCE_GAP_MULTIPLIER;
  let open: (OpenCoverageSegment & { lastObservedAt: string }) | undefined;

  function closeOpen(reason: CoverageCloseReason, endedAt: string): CoverageAggregatorEffect[] {
    if (!open) return [];
    const segment: ClosedCoverageSegment = {
      closeReason: reason,
      coverageState: open.coverageState,
      endedAt,
      intervalMs: open.intervalMs,
      startedAt: open.startedAt,
      tickCount: open.tickCount,
    };
    open = undefined;
    return [{ segment, type: 'closed' }];
  }

  function openNew(
    coverageState: CaptureCoverageState,
    startedAt: string,
    intervalMs: number,
  ): CoverageAggregatorEffect {
    open = { coverageState, intervalMs, lastObservedAt: startedAt, startedAt, tickCount: 1 };
    return { coverageState, intervalMs, startedAt, type: 'opened' };
  }

  return {
    observeCoverage({ state, observedAt, intervalMs }) {
      if (!open) {
        return [openNew(state, observedAt, intervalMs)];
      }

      const gapMs = Date.parse(observedAt) - Date.parse(open.lastObservedAt);
      if (Number.isFinite(gapMs) && gapMs > open.intervalMs * cadenceGapMultiplier) {
        return [
          ...closeOpen('cadence_gap', open.lastObservedAt),
          openNew(state, observedAt, intervalMs),
        ];
      }

      if (open.coverageState === state) {
        open.tickCount += 1;
        open.lastObservedAt = observedAt;
        return [
          {
            coverageState: state,
            endedAt: observedAt,
            tickCount: open.tickCount,
            type: 'extended',
          },
        ];
      }

      return [
        ...closeOpen('state_changed', open.lastObservedAt),
        openNew(state, observedAt, intervalMs),
      ];
    },

    observeCaptureResult({ observedAt }) {
      return closeOpen('frame_captured', open?.lastObservedAt ?? observedAt);
    },

    pause({ observedAt, intervalMs }) {
      if (open?.coverageState === 'paused') return [];
      return [
        ...closeOpen('paused', open?.lastObservedAt ?? observedAt),
        openNew('paused', observedAt, intervalMs),
      ];
    },

    resume({ observedAt }) {
      if (open?.coverageState !== 'paused') return [];
      return closeOpen('state_changed', observedAt);
    },

    handleHelperExit({ observedAt }) {
      return closeOpen('helper_exit', open?.lastObservedAt ?? observedAt);
    },

    getOpenSegment() {
      return open
        ? {
            coverageState: open.coverageState,
            intervalMs: open.intervalMs,
            startedAt: open.startedAt,
            tickCount: open.tickCount,
          }
        : undefined;
    },
  };
}
