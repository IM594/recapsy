import { describe, expect, test } from 'bun:test';
import {
  AppFocusPayloadSchema,
  BlockedPayloadSchema,
  ContextFocusPayloadSchema,
  DedupPayloadSchema,
  TimelineEventEnvelopeSchema,
  TimelineEventsBatchRequestSchema,
  TimelineEventsBatchResponseSchema,
} from '../schemas/timeline-events.js';

const baseEnvelope = {
  clientEventId: 'evt_7c9e1d2f-3a4b-5c6d-7e8f-9a0b1c2d3e4f',
  capturedAt: '2026-07-02T10:00:05.000Z',
  sequence: 42,
  appName: 'Warp',
  windowTitle: 'zsh — recapsy',
};

describe('TimelineEventEnvelopeSchema', () => {
  test('parses valid app_focus', () => {
    const result = TimelineEventEnvelopeSchema.safeParse({
      ...baseEnvelope,
      type: 'app_focus',
      payload: { appName: 'Warp', bundleId: 'dev.warp.Warp-Stable' },
    });

    expect(result.success).toBe(true);
  });

  test('parses valid context_focus', () => {
    const result = TimelineEventEnvelopeSchema.safeParse({
      ...baseEnvelope,
      type: 'context_focus',
      payload: {
        appName: 'Chrome',
        windowTitle: 'GitHub',
        url: 'https://github.com/recapsy/recapsy',
        contextFingerprint: 'chrome:github',
      },
    });

    expect(result.success).toBe(true);
  });

  test('parses valid dedup', () => {
    const result = TimelineEventEnvelopeSchema.safeParse({
      ...baseEnvelope,
      type: 'dedup',
      payload: {
        reason: 'dedup',
        imageHash: 'a1b2c3d4e5f60708',
        hamming: 3,
        threshold: 10,
        skippedUpload: true,
      },
    });

    expect(result.success).toBe(true);
  });

  test('parses valid blocked with all reason enums (O13=A)', () => {
    for (const reason of ['app_blacklist', 'incognito', 'secure_input', 'user_paused'] as const) {
      const result = TimelineEventEnvelopeSchema.safeParse({
        ...baseEnvelope,
        appName: '1Password',
        windowTitle: null,
        type: 'blocked',
        payload: {
          reason,
          appName: '1Password',
          visualState: 'unknown',
        },
      });

      expect(result.success).toBe(true);
    }
  });

  test('rejects mismatched type and payload', () => {
    const result = TimelineEventEnvelopeSchema.safeParse({
      ...baseEnvelope,
      type: 'dedup',
      payload: {
        reason: 'app_blacklist',
        appName: '1Password',
      },
    });

    expect(result.success).toBe(false);
  });

  test('rejects blocked without appName in payload', () => {
    const result = TimelineEventEnvelopeSchema.safeParse({
      ...baseEnvelope,
      type: 'blocked',
      payload: {
        reason: 'incognito',
      },
    });

    expect(result.success).toBe(false);
  });

  test('rejects blocked payload with imageHash', () => {
    const result = BlockedPayloadSchema.safeParse({
      reason: 'secure_input',
      appName: '1Password',
      imageHash: 'deadbeef',
    });

    expect(result.success).toBe(false);
  });

  test('rejects negative sequence', () => {
    const result = TimelineEventEnvelopeSchema.safeParse({
      ...baseEnvelope,
      sequence: -1,
      type: 'app_focus',
      payload: { appName: 'Warp' },
    });

    expect(result.success).toBe(false);
  });

  test('rejects invalid capturedAt', () => {
    const result = TimelineEventEnvelopeSchema.safeParse({
      ...baseEnvelope,
      capturedAt: 'not-a-date',
      type: 'app_focus',
      payload: { appName: 'Warp' },
    });

    expect(result.success).toBe(false);
  });
});

describe('payload schemas', () => {
  test('AppFocusPayloadSchema rejects empty appName', () => {
    expect(AppFocusPayloadSchema.safeParse({ appName: '' }).success).toBe(false);
  });

  test('ContextFocusPayloadSchema rejects invalid url', () => {
    const result = ContextFocusPayloadSchema.safeParse({
      appName: 'Chrome',
      windowTitle: 'GitHub',
      url: 'not-a-url',
    });

    expect(result.success).toBe(false);
  });

  test('DedupPayloadSchema rejects wrong reason literal', () => {
    const result = DedupPayloadSchema.safeParse({
      reason: 'blocked',
      imageHash: 'abc',
      hamming: 0,
      threshold: 10,
    });

    expect(result.success).toBe(false);
  });

  test('DedupPayloadSchema rejects negative hamming', () => {
    const result = DedupPayloadSchema.safeParse({
      reason: 'dedup',
      imageHash: 'abc',
      hamming: -1,
      threshold: 10,
    });

    expect(result.success).toBe(false);
  });
});

describe('TimelineEventsBatchRequestSchema', () => {
  const validEvent = {
    ...baseEnvelope,
    type: 'dedup' as const,
    payload: {
      reason: 'dedup' as const,
      imageHash: 'a1b2c3d4e5f60708',
      hamming: 3,
      threshold: 10,
    },
  };

  test('accepts 1 event', () => {
    const result = TimelineEventsBatchRequestSchema.safeParse({
      events: [validEvent],
    });

    expect(result.success).toBe(true);
  });

  test('accepts 50 events', () => {
    const result = TimelineEventsBatchRequestSchema.safeParse({
      events: Array.from({ length: 50 }, (_, i) => ({
        ...validEvent,
        clientEventId: `evt_${i}`,
        sequence: i,
      })),
    });

    expect(result.success).toBe(true);
  });

  test('rejects 0 events', () => {
    const result = TimelineEventsBatchRequestSchema.safeParse({
      events: [],
    });

    expect(result.success).toBe(false);
  });

  test('rejects 51 events', () => {
    const result = TimelineEventsBatchRequestSchema.safeParse({
      events: Array.from({ length: 51 }, (_, i) => ({
        ...validEvent,
        clientEventId: `evt_${i}`,
        sequence: i,
      })),
    });

    expect(result.success).toBe(false);
  });
});

describe('TimelineEventsBatchResponseSchema', () => {
  test('parses per-event results', () => {
    const result = TimelineEventsBatchResponseSchema.safeParse({
      results: [
        {
          clientEventId: 'evt_1',
          status: 'accepted',
          id: '550e8400-e29b-41d4-a716-446655440000',
        },
        {
          clientEventId: 'evt_2',
          status: 'duplicate',
        },
        {
          clientEventId: 'evt_3',
          status: 'rejected',
          error: 'invalid payload',
        },
      ],
    });

    expect(result.success).toBe(true);
  });
});
