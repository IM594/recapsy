import { describe, expect, test } from 'bun:test';
import {
  type DevAcceptanceDesktopStatus,
  DevAcceptanceDesktopStatusResponseSchema,
  DevAcceptanceDesktopStatusSchema,
} from '../dev-acceptance';

const status: DevAcceptanceDesktopStatus = {
  schemaVersion: 1,
  runtimeInstanceId: '3ce54e1d-5a17-4cb5-a1bc-6f64e2025dd1',
  workspaceId: 'aa0d899f-64b5-41cb-a16f-65a1ea649db7',
  observedAt: '2026-07-18T08:00:00.000Z',
  acceptedCaptureInputPerMinute: 7,
  oldestActiveAgeSeconds: 42,
  workerCapacity: {
    activeWorkers: 2,
    localMaxWorkers: 4,
    serverMaxConcurrentOcr: 3,
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

  test('rejects every forbidden top-level disclosure field', () => {
    const forbiddenFields = [
      'hostname',
      'stableDeviceId',
      'path',
      'app',
      'bundleId',
      'captureAsset',
      'asset',
      'ocr',
      'errorMessage',
      'policyHash',
      'token',
    ];

    for (const field of forbiddenFields) {
      expect(
        DevAcceptanceDesktopStatusSchema.safeParse({ ...status, [field]: 'forbidden' }).success,
      ).toBe(false);
    }
  });

  test('rejects unknown nested fields and free-form reason messages', () => {
    expect(
      DevAcceptanceDesktopStatusSchema.safeParse({
        ...status,
        workerCapacity: { ...status.workerCapacity, hostname: 'desktop.local' },
      }).success,
    ).toBe(false);
    expect(
      DevAcceptanceDesktopStatusSchema.safeParse({
        ...status,
        capture: { ...status.capture, errorMessage: 'private failure details' },
      }).success,
    ).toBe(false);
    expect(
      DevAcceptanceDesktopStatusSchema.safeParse({
        ...status,
        capture: { ...status.capture, pauseReasons: ['private free-form text'] },
      }).success,
    ).toBe(false);
    expect(
      DevAcceptanceDesktopStatusSchema.safeParse({
        ...status,
        admission: { ...status.admission, policyHash: 'sha256:private' },
      }).success,
    ).toBe(false);
  });

  test('rejects invalid counters, timestamps, identities, and impossible capacity', () => {
    const invalidStatuses = [
      { ...status, schemaVersion: 2 },
      { ...status, runtimeInstanceId: 'stable-device-id' },
      { ...status, workspaceId: 'workspace-from-path' },
      { ...status, observedAt: 'yesterday' },
      { ...status, acceptedCaptureInputPerMinute: -1 },
      { ...status, oldestActiveAgeSeconds: -1 },
      {
        ...status,
        workerCapacity: { ...status.workerCapacity, activeWorkers: 4 },
      },
    ];

    for (const invalid of invalidStatuses) {
      expect(DevAcceptanceDesktopStatusSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
