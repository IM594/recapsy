import { describe, expect, it } from 'bun:test';
import type {
  OperationalStoreResult,
  OutboxJob,
  OutboxJobState,
  OutboxTerminalUpdate,
} from '../../storage/index';
import {
  type ServerCaptureReconciliationApi,
  type ServerCaptureReconciliationClock,
  type ServerCaptureReconciliationStore,
  reconcileOutboxJobFromServerCapture,
} from '../reconciliation';

const now = '2026-07-06T00:05:00.000Z';

describe('server capture reconciliation', () => {
  it('does not read, write, or sample the clock without a server capture or for terminal jobs', async () => {
    const ports = recordingPorts('succeeded');

    expect(
      await reconcileOutboxJobFromServerCapture(
        ports,
        outboxJob('pending', { serverCaptureId: undefined }),
      ),
    ).toBeNull();
    for (const state of ['synced', 'blocked', 'failed', 'cancelled'] as const) {
      expect(await reconcileOutboxJobFromServerCapture(ports, outboxJob(state))).toBeNull();
    }

    expect(ports.apiReads).toEqual([]);
    expect(ports.storeWrites).toEqual([]);
    expect(ports.clockReads).toBe(0);
  });

  it('reads the server once and returns null for every non-succeeded OCR state', async () => {
    for (const ocrStatus of ['not_requested', 'queued', 'running', 'failed', 'blocked'] as const) {
      const ports = recordingPorts(ocrStatus);

      const result = await reconcileOutboxJobFromServerCapture(ports, outboxJob('pending'));

      expect(result).toBeNull();
      expect(ports.apiReads).toEqual([
        { captureId: 'server-capture-1', workspaceId: 'workspace-1' },
      ]);
      expect(ports.storeWrites).toEqual([]);
      expect(ports.clockReads).toBe(0);
    }
  });

  it('settles a succeeded capture with exact API and terminal-store arguments', async () => {
    const ports = recordingPorts('succeeded');
    const job = outboxJob('syncing');

    const result = await reconcileOutboxJobFromServerCapture(ports, job);

    expect(ports.apiReads).toEqual([{ captureId: 'server-capture-1', workspaceId: 'workspace-1' }]);
    expect(ports.clockReads).toBe(1);
    expect(ports.storeWrites).toEqual([
      {
        id: 'job-1',
        update: {
          now,
          reason: 'ocr_synced',
          serverCaptureId: 'server-capture-1',
          state: 'synced',
        },
      },
    ]);
    expect(result).toEqual({
      jobId: 'job-1',
      processed: 1,
      status: 'synced',
    });
  });

  it('reports lease loss instead of synced when the terminal CAS loses ownership', async () => {
    const ports = recordingPorts(
      'succeeded',
      {
        error: {
          code: 'outbox_lease_lost',
          message: 'The outbox lease is no longer owned by this worker.',
        },
        ok: false,
      },
      outboxJob('syncing', { leaseToken: 'new-owner-lease' }),
    );

    const result = await reconcileOutboxJobFromServerCapture(ports, outboxJob('syncing'));

    expect(ports.storeWrites).toHaveLength(1);
    expect(ports.storeReads).toEqual(['job-1']);
    expect(result).toEqual({
      code: 'lease_lost',
      jobId: 'job-1',
      processed: 0,
      status: 'skipped',
    });
  });

  it('treats a rejected terminal write as idempotent only after reading synced state', async () => {
    const ports = recordingPorts(
      'succeeded',
      {
        error: {
          code: 'terminal_state_conflict',
          message: 'The job became terminal concurrently.',
        },
        ok: false,
      },
      outboxJob('synced', { leaseToken: undefined }),
    );

    const result = await reconcileOutboxJobFromServerCapture(ports, outboxJob('syncing'));

    expect(ports.storeReads).toEqual(['job-1']);
    expect(result).toEqual({
      jobId: 'job-1',
      processed: 1,
      status: 'synced',
    });
  });

  it('does not accept a synced row bound to a different server capture', async () => {
    const ports = recordingPorts(
      'succeeded',
      {
        error: {
          code: 'terminal_state_conflict',
          message: 'The job became terminal concurrently.',
        },
        ok: false,
      },
      outboxJob('synced', {
        leaseToken: undefined,
        serverCaptureId: 'different-server-capture',
      }),
    );

    const result = await reconcileOutboxJobFromServerCapture(ports, outboxJob('syncing'));

    expect(result).toEqual({
      jobId: 'job-1',
      processed: 0,
      status: 'skipped',
    });
  });
});

type CaptureOcrStatus = Awaited<
  ReturnType<ServerCaptureReconciliationApi['getCapture']>
>['ocrStatus'];

function recordingPorts(
  ocrStatus: CaptureOcrStatus,
  storeResult?: OperationalStoreResult<OutboxJob>,
  currentJob: OutboxJob | null = null,
): {
  api: ServerCaptureReconciliationApi;
  apiReads: Array<{ workspaceId: string; captureId: string }>;
  clock: ServerCaptureReconciliationClock;
  clockReads: number;
  store: ServerCaptureReconciliationStore;
  storeReads: string[];
  storeWrites: Array<{ id: string; update: OutboxTerminalUpdate }>;
} {
  const apiReads: Array<{ workspaceId: string; captureId: string }> = [];
  const storeReads: string[] = [];
  const storeWrites: Array<{ id: string; update: OutboxTerminalUpdate }> = [];
  let clockReads = 0;
  const api = {
    async getCapture(workspaceId: string, captureId: string) {
      apiReads.push({ captureId, workspaceId });
      return { captureId, ocrStatus };
    },
  } satisfies ServerCaptureReconciliationApi;
  const clock = {
    now() {
      clockReads += 1;
      return now;
    },
  } satisfies ServerCaptureReconciliationClock;
  const store = {
    async getOutboxJob(id: string) {
      storeReads.push(id);
      return currentJob;
    },
    async markOutboxJobTerminal(id: string, update: OutboxTerminalUpdate) {
      storeWrites.push({ id, update });
      return storeResult ?? { ok: true, value: outboxJob('synced') };
    },
  } satisfies ServerCaptureReconciliationStore;

  return {
    api,
    apiReads,
    clock,
    get clockReads() {
      return clockReads;
    },
    store,
    storeReads,
    storeWrites,
  };
}

function outboxJob(state: OutboxJobState, overrides: Partial<OutboxJob> = {}): OutboxJob {
  return {
    assetRefId: 'asset-1',
    attempt: 1,
    capture: {
      appName: 'Code',
      captureType: 'screen',
      capturedAt: now,
      observedAt: now,
      privacyDecision: {
        action: 'allow',
        decidedAt: now,
        policyVersion: 'policy-1',
        reasons: [],
      },
    },
    createdAt: now,
    deviceId: 'device-1',
    id: 'job-1',
    idempotencyKey: 'idempotency-1',
    payloadHash: 'sha256:job-1',
    serverCaptureId: 'server-capture-1',
    state,
    updatedAt: now,
    workspaceId: 'workspace-1',
    ...overrides,
  };
}
