import { describe, expect, it } from 'bun:test';
import { createCoverageAggregator } from '../coverage-aggregator';

const t0 = '2026-07-20T08:00:00.000Z';
const t1 = '2026-07-20T08:00:03.000Z';
const t2 = '2026-07-20T08:00:06.000Z';
const intervalMs = 3000;

describe('coverage aggregator', () => {
  it('opens a segment on the first observation', () => {
    const aggregator = createCoverageAggregator();

    const effects = aggregator.observeCoverage({ intervalMs, observedAt: t0, state: 'static' });

    expect(effects).toEqual([
      { coverageState: 'static', intervalMs, startedAt: t0, type: 'opened' },
    ]);
    expect(aggregator.getOpenSegment()).toEqual({
      coverageState: 'static',
      intervalMs,
      startedAt: t0,
      tickCount: 1,
    });
  });

  it('extends the open segment while the coverage state repeats', () => {
    const aggregator = createCoverageAggregator();
    aggregator.observeCoverage({ intervalMs, observedAt: t0, state: 'static' });

    const effects = aggregator.observeCoverage({ intervalMs, observedAt: t1, state: 'static' });

    expect(effects).toEqual([
      { coverageState: 'static', endedAt: t1, tickCount: 2, type: 'extended' },
    ]);
    expect(aggregator.getOpenSegment()).toMatchObject({ tickCount: 2 });
  });

  it('closes with state_changed and opens the new state when coverage changes', () => {
    const aggregator = createCoverageAggregator();
    aggregator.observeCoverage({ intervalMs, observedAt: t0, state: 'static' });
    aggregator.observeCoverage({ intervalMs, observedAt: t1, state: 'static' });

    const effects = aggregator.observeCoverage({ intervalMs, observedAt: t2, state: 'no_window' });

    expect(effects).toEqual([
      {
        segment: {
          closeReason: 'state_changed',
          coverageState: 'static',
          endedAt: t1,
          intervalMs,
          startedAt: t0,
          tickCount: 2,
        },
        type: 'closed',
      },
      { coverageState: 'no_window', intervalMs, startedAt: t2, type: 'opened' },
    ]);
  });

  it('closes with cadence_gap when the tick gap exceeds the cadence multiplier', () => {
    const aggregator = createCoverageAggregator({ cadenceGapMultiplier: 2 });
    aggregator.observeCoverage({ intervalMs, observedAt: t0, state: 'static' });

    const afterSleep = '2026-07-20T08:10:00.000Z';
    const effects = aggregator.observeCoverage({
      intervalMs,
      observedAt: afterSleep,
      state: 'static',
    });

    expect(effects).toEqual([
      {
        segment: {
          closeReason: 'cadence_gap',
          coverageState: 'static',
          endedAt: t0,
          intervalMs,
          startedAt: t0,
          tickCount: 1,
        },
        type: 'closed',
      },
      { coverageState: 'static', intervalMs, startedAt: afterSleep, type: 'opened' },
    ]);
  });

  it('does not treat a gap within the cadence multiplier as a cadence gap', () => {
    const aggregator = createCoverageAggregator({ cadenceGapMultiplier: 2 });
    aggregator.observeCoverage({ intervalMs, observedAt: t0, state: 'static' });

    // Exactly at the multiplier boundary (2 * intervalMs) is still in-cadence.
    const withinBudget = '2026-07-20T08:00:06.000Z';
    const effects = aggregator.observeCoverage({
      intervalMs,
      observedAt: withinBudget,
      state: 'static',
    });

    expect(effects).toEqual([
      { coverageState: 'static', endedAt: withinBudget, tickCount: 2, type: 'extended' },
    ]);
  });

  it('closes with frame_captured when a capture result arrives', () => {
    const aggregator = createCoverageAggregator();
    aggregator.observeCoverage({ intervalMs, observedAt: t0, state: 'blank' });
    aggregator.observeCoverage({ intervalMs, observedAt: t1, state: 'blank' });

    const effects = aggregator.observeCaptureResult({ observedAt: t2 });

    expect(effects).toEqual([
      {
        segment: {
          closeReason: 'frame_captured',
          coverageState: 'blank',
          endedAt: t1,
          intervalMs,
          startedAt: t0,
          tickCount: 2,
        },
        type: 'closed',
      },
    ]);
    expect(aggregator.getOpenSegment()).toBeUndefined();
  });

  it('is a no-op for a capture result when nothing is open', () => {
    const aggregator = createCoverageAggregator();

    expect(aggregator.observeCaptureResult({ observedAt: t0 })).toEqual([]);
  });

  it('closes the prior run with paused and opens a synthetic paused run', () => {
    const aggregator = createCoverageAggregator();
    aggregator.observeCoverage({ intervalMs, observedAt: t0, state: 'static' });

    const effects = aggregator.pause({ intervalMs, observedAt: t1 });

    expect(effects).toEqual([
      {
        segment: {
          closeReason: 'paused',
          coverageState: 'static',
          endedAt: t0,
          intervalMs,
          startedAt: t0,
          tickCount: 1,
        },
        type: 'closed',
      },
      { coverageState: 'paused', intervalMs, startedAt: t1, type: 'opened' },
    ]);
  });

  it('is a no-op when pausing while already paused', () => {
    const aggregator = createCoverageAggregator();
    aggregator.pause({ intervalMs, observedAt: t0 });

    expect(aggregator.pause({ intervalMs, observedAt: t1 })).toEqual([]);
  });

  it('closes an open paused run on resume, using the resume instant as the end boundary', () => {
    const aggregator = createCoverageAggregator();
    aggregator.pause({ intervalMs, observedAt: t0 });

    const effects = aggregator.resume({ observedAt: t2 });

    expect(effects).toEqual([
      {
        segment: {
          closeReason: 'state_changed',
          coverageState: 'paused',
          endedAt: t2,
          intervalMs,
          startedAt: t0,
          tickCount: 1,
        },
        type: 'closed',
      },
    ]);
  });

  it('is a no-op resuming when nothing paused is open', () => {
    const aggregator = createCoverageAggregator();
    aggregator.observeCoverage({ intervalMs, observedAt: t0, state: 'static' });

    expect(aggregator.resume({ observedAt: t1 })).toEqual([]);
    expect(aggregator.getOpenSegment()).toMatchObject({ coverageState: 'static' });
  });

  it('closes any open run with helper_exit', () => {
    const aggregator = createCoverageAggregator();
    aggregator.observeCoverage({ intervalMs, observedAt: t0, state: 'private_context' });
    aggregator.observeCoverage({ intervalMs, observedAt: t1, state: 'private_context' });

    const effects = aggregator.handleHelperExit({ observedAt: t2 });

    expect(effects).toEqual([
      {
        segment: {
          closeReason: 'helper_exit',
          coverageState: 'private_context',
          endedAt: t1,
          intervalMs,
          startedAt: t0,
          tickCount: 2,
        },
        type: 'closed',
      },
    ]);
    expect(aggregator.getOpenSegment()).toBeUndefined();
  });

  it('is a no-op for helper_exit when nothing is open', () => {
    const aggregator = createCoverageAggregator();

    expect(aggregator.handleHelperExit({ observedAt: t0 })).toEqual([]);
  });
});
