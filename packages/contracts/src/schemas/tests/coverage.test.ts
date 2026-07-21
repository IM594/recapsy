import { describe, expect, it } from 'bun:test';
import {
  CaptureCoverageBatchCreateRequestSchema,
  CaptureCoverageStateSchema,
  DeviceCaptureLivenessUpsertRequestSchema,
  FilmstripQuerySchema,
  FilmstripResponseSchema,
  FilmstripTickSchema,
} from '../../index.js';

const workspaceId = '22222222-2222-4222-8222-222222222222';
const deviceId = 'device-abc';
const startedAt = '2026-07-06T00:00:00.000Z';
const endedAt = '2026-07-06T01:00:00.000Z';

describe('capture coverage contracts', () => {
  it('accepts the eight recordable coverage states', () => {
    for (const state of [
      'static',
      'blank',
      'low_information',
      'no_window',
      'privacy_withheld',
      'secure_field',
      'private_context',
      'paused',
    ] as const) {
      expect(CaptureCoverageStateSchema.parse(state)).toBe(state);
    }
  });

  it('rejects inferred-only states that must never be recorded as facts', () => {
    expect(CaptureCoverageStateSchema.safeParse('gap').success).toBe(false);
    expect(CaptureCoverageStateSchema.safeParse('not_running').success).toBe(false);
  });

  it('accepts a batch of closed coverage segments', () => {
    const parsed = CaptureCoverageBatchCreateRequestSchema.parse({
      workspaceId,
      segments: [
        {
          deviceId,
          coverageState: 'static',
          startedAt,
          endedAt,
          tickCount: 1200,
          intervalMs: 3000,
        },
      ],
    });

    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0]?.coverageState).toBe('static');
  });

  it('rejects an empty batch', () => {
    expect(
      CaptureCoverageBatchCreateRequestSchema.safeParse({ workspaceId, segments: [] }).success,
    ).toBe(false);
  });

  it('upserts device liveness with an optional open segment head', () => {
    const parsed = DeviceCaptureLivenessUpsertRequestSchema.parse({
      workspaceId,
      deviceId,
      lastAliveAt: startedAt,
      desiredState: 'running',
      openCoverageState: 'static',
      openCoverageStartedAt: startedAt,
    });

    expect(parsed.desiredState).toBe('running');
    expect(parsed.openCoverageState).toBe('static');
  });

  it('allows liveness without an open segment', () => {
    const parsed = DeviceCaptureLivenessUpsertRequestSchema.parse({
      workspaceId,
      deviceId,
      lastAliveAt: startedAt,
      desiredState: 'stopped',
    });

    expect(parsed.openCoverageState).toBeUndefined();
  });
});

describe('filmstrip read contracts', () => {
  it('classifies a downtime gap distinctly from a static hold', () => {
    const hold = FilmstripTickSchema.parse({
      at: startedAt,
      disposition: 'hold',
      heldFromCaptureId: '33333333-3333-4333-8333-333333333333',
    });
    const downtime = FilmstripTickSchema.parse({
      at: endedAt,
      disposition: 'gap',
      gapKind: 'downtime',
    });

    expect(hold.disposition).toBe('hold');
    expect(downtime.gapKind).toBe('downtime');
  });

  it('rejects an unknown disposition and stray fields', () => {
    expect(FilmstripTickSchema.safeParse({ at: startedAt, disposition: 'skipped' }).success).toBe(
      false,
    );
    expect(
      FilmstripTickSchema.safeParse({ at: startedAt, disposition: 'accepted', extra: 1 }).success,
    ).toBe(false);
  });

  it('parses a filmstrip query and applies the default page size', () => {
    const parsed = FilmstripQuerySchema.parse({
      workspaceId,
      deviceId,
      from: startedAt,
      to: endedAt,
      intervalMs: 3000,
    });

    expect(parsed.limit).toBe(500);
  });

  it('rejects a query missing the tick cadence and an oversized page', () => {
    expect(
      FilmstripQuerySchema.safeParse({ workspaceId, deviceId, from: startedAt, to: endedAt })
        .success,
    ).toBe(false);
    expect(
      FilmstripQuerySchema.safeParse({
        workspaceId,
        deviceId,
        from: startedAt,
        to: endedAt,
        intervalMs: 3000,
        limit: 5001,
      }).success,
    ).toBe(false);
  });

  it('parses a filmstrip response with paged ticks', () => {
    const parsed = FilmstripResponseSchema.parse({
      workspaceId,
      deviceId,
      ticks: [{ at: startedAt, disposition: 'gap', gapKind: 'frame_drop' }],
      pageInfo: { nextCursor: endedAt, hasMore: true },
      generatedAt: endedAt,
    });

    expect(parsed.ticks).toHaveLength(1);
    expect(parsed.pageInfo.hasMore).toBe(true);
  });
});
