import { describe, expect, test } from 'bun:test';
import { DevAcceptanceDesktopStatusSchema } from '@recapsy/contracts';
import { projectDesktopAcceptanceStatus } from '../projection';
import { deriveLocalStage, projectAcceptanceQueue } from '../queue-projection';
import { acceptanceSnapshot } from './support';

describe('desktop acceptance projection', () => {
  test('projects queue lifecycle fields for schema version 3', () => {
    const projection = projectDesktopAcceptanceStatus({
      runtimeInstanceId: '3ce54e1d-5a17-4cb5-a1bc-6f64e2025dd1',
      workspaceId: 'aa0d899f-64b5-41cb-a16f-65a1ea649db7',
      observedAt: '2026-07-18T08:00:00.000Z',
      snapshot: acceptanceSnapshot({
        capturePauseReasons: ['user', 'backpressure', 'storage', 'policy', 'permission'],
      }),
    });

    expect(DevAcceptanceDesktopStatusSchema.parse(projection)).toEqual(projection);
    expect(projection.schemaVersion).toBe(3);
    expect(projection.syncGate).toEqual({ state: 'open' });
    expect(projection.queue.failed).toBe(2);
    expect(projection.inFlight).toHaveLength(1);
    expect(projection.queueHeads[0]?.safeErrorCode).toBe('provider_timeout');
  });

  test('uses null when the shared shell summary has no active queue age', () => {
    const projection = projectDesktopAcceptanceStatus({
      runtimeInstanceId: '3ce54e1d-5a17-4cb5-a1bc-6f64e2025dd1',
      workspaceId: 'aa0d899f-64b5-41cb-a16f-65a1ea649db7',
      observedAt: '2026-07-18T08:00:00.000Z',
      snapshot: acceptanceSnapshot({ syncOldestActiveAgeSeconds: undefined }),
    });

    expect(projection.oldestActiveAgeSeconds).toBeNull();
  });

  test('fails closed when an internal snapshot contains an unapproved reason code', () => {
    expect(() =>
      projectDesktopAcceptanceStatus({
        runtimeInstanceId: '3ce54e1d-5a17-4cb5-a1bc-6f64e2025dd1',
        workspaceId: 'aa0d899f-64b5-41cb-a16f-65a1ea649db7',
        observedAt: '2026-07-18T08:00:00.000Z',
        snapshot: acceptanceSnapshot({
          capturePauseReasons: ['private error message' as 'user'],
        }),
      }),
    ).toThrow();
  });

  test('drops free-form unsafe error strings instead of inventing opaque unknown', () => {
    const projection = projectDesktopAcceptanceStatus({
      runtimeInstanceId: '3ce54e1d-5a17-4cb5-a1bc-6f64e2025dd1',
      workspaceId: 'aa0d899f-64b5-41cb-a16f-65a1ea649db7',
      observedAt: '2026-07-18T08:00:00.000Z',
      snapshot: acceptanceSnapshot({ safeErrorCode: '/private/path' }),
    });

    expect(projection.safeErrorCode).toBeNull();
  });
});

describe('acceptance queue projection', () => {
  test('derives local stages and splits in-flight from queue heads including failed', () => {
    const now = Date.parse('2026-07-18T08:00:42.000Z');
    const projection = projectAcceptanceQueue(
      [
        {
          id: 'cap-1',
          state: 'syncing',
          attempt: 0,
          createdAt: '2026-07-18T08:00:00.000Z',
          updatedAt: '2026-07-18T08:00:10.000Z',
          serverCaptureId: '11111111-1111-4111-8111-111111111111',
          capture: { appName: 'Cursor' },
        },
        {
          id: 'cap-2',
          state: 'pending',
          attempt: 1,
          createdAt: '2026-07-18T07:59:00.000Z',
          updatedAt: '2026-07-18T08:00:20.000Z',
          nextRetryAt: '2026-07-18T08:01:00.000Z',
          capture: { appName: 'Safari' },
        },
        {
          id: 'cap-3',
          state: 'failed',
          attempt: 4,
          createdAt: '2026-07-18T07:50:00.000Z',
          updatedAt: '2026-07-18T08:00:30.000Z',
          lastSafeError: {
            code: 'provider_timeout',
            message: 'OCR provider timed out.',
            retryable: true,
          },
          capture: { appName: 'Notes' },
        },
      ],
      now,
    );

    expect(
      deriveLocalStage({
        id: 'cap-x',
        state: 'pending',
        attempt: 0,
        createdAt: '2026-07-18T08:00:00.000Z',
        updatedAt: '2026-07-18T08:00:00.000Z',
        nextRetryAt: '2026-07-18T08:01:00.000Z',
        capture: { appName: 'X' },
      }),
    ).toBe('retry_wait');
    expect(projection.inFlight).toEqual([
      {
        localJobId: 'cap-1',
        serverCaptureId: '11111111-1111-4111-8111-111111111111',
        appName: 'Cursor',
        localStage: 'running_ocr',
        attempt: 0,
        ageSeconds: 42,
        safeErrorCode: null,
        createdAt: '2026-07-18T08:00:00.000Z',
        updatedAt: '2026-07-18T08:00:10.000Z',
        nextRetryAt: null,
      },
    ]);
    expect(projection.queue).toEqual({
      pending: 1,
      syncing: 1,
      resultPending: 0,
      retrying: 1,
      failed: 1,
      blocked: 0,
    });
    expect(projection.queueHeads.map((item) => item.localJobId)).toEqual(['cap-3', 'cap-2']);
    expect(projection.queueHeads[0]?.safeErrorCode).toBe('provider_timeout');
  });

  test('puts recently synced jobs first in queue heads so successes are visible', () => {
    const now = Date.parse('2026-07-18T08:00:42.000Z');
    const projection = projectAcceptanceQueue(
      [
        {
          id: 'cap-ok',
          state: 'synced',
          attempt: 0,
          createdAt: '2026-07-18T08:00:00.000Z',
          updatedAt: '2026-07-18T08:00:40.000Z',
          serverCaptureId: '11111111-1111-4111-8111-111111111111',
          capture: { appName: 'Cursor' },
        },
        {
          id: 'cap-fail',
          state: 'failed',
          attempt: 2,
          createdAt: '2026-07-18T07:00:00.000Z',
          updatedAt: '2026-07-18T08:00:30.000Z',
          lastSafeError: {
            code: 'provider_timeout',
            message: 'OCR provider timed out.',
            retryable: true,
          },
          capture: { appName: 'Safari' },
        },
      ],
      now,
    );

    expect(projection.queueHeads.map((item) => item.localJobId)).toEqual(['cap-ok', 'cap-fail']);
    expect(projection.queueHeads[0]?.localStage).toBe('synced');
  });

  test('does not surface historical lastSafeError from synced jobs as current abnormality', () => {
    const now = Date.parse('2026-07-18T08:00:42.000Z');
    const projection = projectAcceptanceQueue(
      [
        {
          id: 'cap-ok',
          state: 'synced',
          attempt: 2,
          createdAt: '2026-07-18T08:00:00.000Z',
          updatedAt: '2026-07-18T08:00:40.000Z',
          serverCaptureId: '11111111-1111-4111-8111-111111111111',
          lastSafeError: {
            code: 'provider_timeout',
            message: 'OCR provider timed out.',
            retryable: true,
          },
          capture: { appName: 'Cursor' },
        },
        {
          id: 'cap-running',
          state: 'syncing',
          attempt: 0,
          createdAt: '2026-07-18T08:00:30.000Z',
          updatedAt: '2026-07-18T08:00:35.000Z',
          serverCaptureId: '22222222-2222-4222-8222-222222222222',
          capture: { appName: 'Safari' },
        },
      ],
      now,
    );

    expect(projection.safeErrorCode).toBeUndefined();
    expect(projection.queueHeads.find((item) => item.localJobId === 'cap-ok')?.safeErrorCode).toBe(
      null,
    );
    expect(projection.inFlight[0]?.safeErrorCode).toBeNull();
  });

  test('projects persisted OCR identity and never invents identity for jobs without a result', () => {
    const projection = projectAcceptanceQueue(
      [
        {
          id: 'cap-with-result',
          state: 'synced',
          attempt: 0,
          createdAt: '2026-07-18T08:00:00.000Z',
          updatedAt: '2026-07-18T08:00:40.000Z',
          ocrResult: {
            durationMs: 10,
            model: 'model-at-execution',
            providerName: 'provider-at-execution',
            qualityFlags: [],
            screenText: {
              blocks: [],
              readingOrder: 'top_to_bottom_left_to_right',
              source: 'image_ocr',
            },
            activity: {
              activitySummary: null,
              entities: [],
              actionHints: [],
              embeddingCandidateText: null,
              metadata: { observationStatus: 'omitted' },
            },
            activityStatus: 'omitted',
            sourceAssetHash: 'sha256:persisted',
          },
        },
        {
          id: 'cap-without-result',
          state: 'failed',
          attempt: 1,
          createdAt: '2026-07-18T07:59:00.000Z',
          updatedAt: '2026-07-18T08:00:30.000Z',
        },
      ],
      Date.parse('2026-07-18T08:01:00.000Z'),
    );

    expect(projection.queueHeads.find((job) => job.localJobId === 'cap-with-result')).toMatchObject(
      {
        model: 'model-at-execution',
        providerName: 'provider-at-execution',
      },
    );
    expect(
      projection.queueHeads.find((job) => job.localJobId === 'cap-without-result'),
    ).not.toHaveProperty('model');
  });
});
