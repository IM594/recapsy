import { describe, expect, test } from 'bun:test';
import {
  type DevAcceptanceDesktopStatus,
  DevAcceptanceDesktopStatusResponseSchema,
  DevAcceptanceDesktopStatusSchema,
} from '../dev-acceptance';

const status: DevAcceptanceDesktopStatus = {
  schemaVersion: 3,
  runtimeInstanceId: '3ce54e1d-5a17-4cb5-a1bc-6f64e2025dd1',
  workspaceId: 'aa0d899f-64b5-41cb-a16f-65a1ea649db7',
  observedAt: '2026-07-18T08:00:00.000Z',
  acceptedCaptureInputPerMinute: 7,
  completedPerMinute: 5,
  processing: 2,
  pending: 3,
  oldestActiveAgeSeconds: 42,
  policyVersion: 'policy-primary',
  safeErrorCode: 'provider_unavailable',
  workerCapacity: {
    activeWorkers: 2,
    localMaxWorkers: 4,
    serverMaxConcurrentOcr: 3,
  },
  syncGate: {
    nextProbeAt: '2026-07-18T08:01:00.000Z',
    pausedAt: '2026-07-18T08:00:00.000Z',
    reason: 'provider_auth_failed',
    state: 'paused',
  },
  capture: {
    state: 'paused',
    paused: true,
    pauseReasons: ['user', 'storage'],
  },
  admission: {
    active: true,
    reasons: ['max_asset_bytes_reached'],
  },
  queue: {
    pending: 3,
    syncing: 1,
    resultPending: 1,
    retrying: 1,
    failed: 2,
    blocked: 0,
  },
  inFlight: [
    {
      localJobId: 'cap-1780000000000-1',
      serverCaptureId: '11111111-1111-4111-8111-111111111111',
      appName: 'Cursor',
      localStage: 'running_ocr',
      attempt: 1,
      ageSeconds: 12,
      safeErrorCode: null,
      createdAt: '2026-07-18T07:59:48.000Z',
      updatedAt: '2026-07-18T08:00:00.000Z',
      nextRetryAt: null,
    },
  ],
  queueHeads: [
    {
      localJobId: 'cap-1780000000000-2',
      serverCaptureId: null,
      appName: 'Safari',
      localStage: 'failed',
      attempt: 3,
      ageSeconds: 90,
      safeErrorCode: 'provider_timeout',
      createdAt: '2026-07-18T07:58:30.000Z',
      updatedAt: '2026-07-18T08:00:00.000Z',
      nextRetryAt: null,
    },
  ],
};

describe('development acceptance desktop status contract', () => {
  test('accepts only the bounded local control-plane projection', () => {
    expect(DevAcceptanceDesktopStatusSchema.parse(status)).toEqual(status);
    expect(
      DevAcceptanceDesktopStatusResponseSchema.parse({
        connection: 'connected',
        status,
      }),
    ).toEqual({ connection: 'connected', status });
    expect(
      DevAcceptanceDesktopStatusResponseSchema.parse({
        connection: 'disconnected',
        status: null,
      }),
    ).toEqual({ connection: 'disconnected', status: null });
  });

  test('rejects free-form unsafe fields in the relay projection', () => {
    expect(
      DevAcceptanceDesktopStatusSchema.safeParse({
        ...status,
        policyVersion: '/Users/private/policy',
      }).success,
    ).toBe(false);
    expect(
      DevAcceptanceDesktopStatusSchema.safeParse({
        ...status,
        safeErrorCode: 'Not A Code',
      }).success,
    ).toBe(false);
    expect(
      DevAcceptanceDesktopStatusSchema.safeParse({
        ...status,
        capture: { ...status.capture, pauseReasons: ['private error message'] },
      }).success,
    ).toBe(false);
    expect(
      DevAcceptanceDesktopStatusSchema.safeParse({
        ...status,
        inFlight: [{ ...status.inFlight[0], appName: '/Users/secret' }],
      }).success,
    ).toBe(false);
    expect(
      DevAcceptanceDesktopStatusSchema.safeParse({
        ...status,
        inFlight: [{ ...status.inFlight[0], localJobId: 'bad id with spaces' }],
      }).success,
    ).toBe(false);
  });

  test('rejects worker capacity that exceeds an effective limit', () => {
    expect(
      DevAcceptanceDesktopStatusSchema.safeParse({
        ...status,
        workerCapacity: {
          activeWorkers: 5,
          localMaxWorkers: 4,
          serverMaxConcurrentOcr: 3,
        },
      }).success,
    ).toBe(false);
  });

  test('rejects unbounded provider gate reasons', () => {
    expect(
      DevAcceptanceDesktopStatusSchema.safeParse({
        ...status,
        syncGate: { reason: 'private provider response', state: 'paused' },
      }).success,
    ).toBe(false);
  });

  test('passes through snake_case operational safe error codes on queue heads', () => {
    expect(
      DevAcceptanceDesktopStatusSchema.parse({
        ...status,
        queueHeads: [
          {
            ...status.queueHeads[0],
            safeErrorCode: 'local_asset_missing',
          },
        ],
      }).queueHeads[0]?.safeErrorCode,
    ).toBe('local_asset_missing');
  });

  test('carries only persisted OCR execution identity and accepts legacy jobs without it', () => {
    const current = DevAcceptanceDesktopStatusSchema.parse({
      ...status,
      syncGate: {
        nextProbeAt: '2026-07-18T08:01:00.000Z',
        pausedAt: '2026-07-18T08:00:00.000Z',
        reason: 'provider_configuration_invalid',
        state: 'paused',
      },
      queueHeads: [
        {
          ...status.queueHeads[0],
          model: 'ocr-model-at-execution',
          providerName: 'openai-compatible',
          safeErrorCode: 'provider_configuration_invalid',
        },
      ],
    });
    expect(current.queueHeads[0]).toMatchObject({
      model: 'ocr-model-at-execution',
      providerName: 'openai-compatible',
    });

    const legacy = DevAcceptanceDesktopStatusSchema.parse(status);
    expect(legacy.queueHeads[0]).not.toHaveProperty('model');
    expect(legacy.queueHeads[0]).not.toHaveProperty('providerName');
  });
});
