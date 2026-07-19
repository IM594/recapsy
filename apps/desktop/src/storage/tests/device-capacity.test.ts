import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AssetCacheRef,
  type CaptureOutboxEntryCreateInput,
  createMemoryStore,
  createSqliteStore,
  evaluateOperationalStoreBackpressure,
} from '../index';
import { createBunSqliteDatabase } from '../sqlite/bun';

const now = '2026-07-18T00:00:00.000Z';
const workspaceA = 'workspace_a';
const workspaceB = 'workspace_b';
const maxActiveJobs = 24;
const tempDirs: string[] = [];

type CapacityStore = Pick<
  ReturnType<typeof createMemoryStore>,
  | 'createCaptureOutboxEntry'
  | 'getAssetCacheRef'
  | 'getBackpressureSnapshot'
  | 'markOutboxJobTerminal'
>;

type StoreFixture = {
  close(): void;
  store: CapacityStore;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe('device-wide outbox capacity contract', () => {
  const fixtures: Array<{ name: string; create(): Promise<StoreFixture> }> = [
    {
      name: 'Memory',
      async create() {
        return {
          close() {},
          store: createMemoryStore({ maxActiveOutboxJobs: maxActiveJobs }),
        };
      },
    },
    {
      name: 'SQLite',
      async create() {
        const dir = mkdtempSync(join(tmpdir(), 'recapsy-device-capacity-'));
        tempDirs.push(dir);
        const store = createSqliteStore({
          database: createBunSqliteDatabase(join(dir, 'operational.sqlite')),
          maxActiveOutboxJobs: maxActiveJobs,
        });
        await store.initialize();
        return { close: () => store.close(), store };
      },
    },
  ];

  for (const fixture of fixtures) {
    it(`${fixture.name} reports device-wide resources from every workspace`, async () => {
      const { close, store } = await fixture.create();

      try {
        await fillDeviceCapacity(store);

        const snapshotFromWorkspaceB = await store.getBackpressureSnapshot();
        expect(snapshotFromWorkspaceB).toEqual({
          assetBytes: 256 + maxActiveJobs * 128,
          queuedJobs: maxActiveJobs,
          retryingJobs: 1,
        });
        expect(
          evaluateOperationalStoreBackpressure(snapshotFromWorkspaceB, {
            maxAssetBytes: 1024 * 1024,
            maxQueuedJobs: maxActiveJobs,
            maxRetryingJobs: 8,
            resumeAssetBytes: 512 * 1024,
            resumeQueuedJobs: 8,
            resumeRetryingJobs: 2,
          }),
        ).toEqual({
          action: 'pause',
          hardLimit: true,
          reasons: ['max_queued_jobs_reached'],
        });
      } finally {
        close();
      }
    });

    it(`${fixture.name} replays accepted receipts but rejects new receipts at device capacity`, async () => {
      const { close, store } = await fixture.create();

      try {
        const { workspaceAReceipts, workspaceBReceipt } = await fillDeviceCapacity(store);
        const workspaceAReceipt = workspaceAReceipts[0];
        if (!workspaceAReceipt) throw new Error('Expected a seeded workspace A receipt.');

        expect(await store.createCaptureOutboxEntry(workspaceAReceipt)).toMatchObject({
          ok: true,
          value: { id: workspaceAReceipt.id },
        });
        expect(await store.createCaptureOutboxEntry(workspaceBReceipt)).toMatchObject({
          ok: true,
          value: { id: workspaceBReceipt.id },
        });

        const newWorkspaceAReceipt = createEntry('workspace_a_overflow', workspaceA, 128);
        const newWorkspaceBReceipt = createEntry('workspace_b_overflow', workspaceB, 128);
        expect(await store.createCaptureOutboxEntry(newWorkspaceAReceipt)).toMatchObject({
          error: { code: 'capacity_exceeded' },
          ok: false,
        });
        expect(await store.createCaptureOutboxEntry(newWorkspaceBReceipt)).toMatchObject({
          error: { code: 'capacity_exceeded' },
          ok: false,
        });
        expect(await store.getAssetCacheRef(newWorkspaceAReceipt.assetRefId)).toBeNull();
        expect(await store.getAssetCacheRef(newWorkspaceBReceipt.assetRefId)).toBeNull();
      } finally {
        close();
      }
    });
  }
});

async function fillDeviceCapacity(store: CapacityStore): Promise<{
  workspaceAReceipts: CaptureOutboxEntryCreateInput[];
  workspaceBReceipt: CaptureOutboxEntryCreateInput;
}> {
  const workspaceBReceipt = createEntry('workspace_b_existing', workspaceB, 256);
  const workspaceAReceipts = Array.from({ length: maxActiveJobs }, (_, index) =>
    createEntry(
      `workspace_a_${index}`,
      workspaceA,
      128,
      index === 0 ? '2026-07-18T00:01:00.000Z' : undefined,
    ),
  );

  expect(await store.createCaptureOutboxEntry(workspaceBReceipt)).toMatchObject({ ok: true });
  expect(
    await store.markOutboxJobTerminal(workspaceBReceipt.id, {
      now,
      reason: 'already_synced',
      state: 'synced',
    }),
  ).toMatchObject({ ok: true });

  for (const entry of workspaceAReceipts) {
    expect(await store.createCaptureOutboxEntry(entry)).toMatchObject({ ok: true });
  }

  return { workspaceAReceipts, workspaceBReceipt };
}

function createEntry(
  id: string,
  workspaceId: string,
  sizeBytes: number,
  nextRetryAt?: string,
): CaptureOutboxEntryCreateInput {
  const assetRefId = `asset_${id}`;
  return {
    assetRefId,
    assetRefs: [createAsset(assetRefId, workspaceId, sizeBytes)],
    createdAt: now,
    deviceId: 'device_1',
    id: `job_${id}`,
    idempotencyKey: `receipt_${id}`,
    payloadHash: sha256(`payload_${id}`),
    workspaceId,
    ...(nextRetryAt ? { nextRetryAt } : {}),
  };
}

function createAsset(assetRefId: string, workspaceId: string, sizeBytes: number): AssetCacheRef {
  return {
    assetRefId,
    availabilityState: 'available',
    cleanupState: 'retained',
    createdAt: now,
    hash: sha256(assetRefId),
    localAccessKey: `captures/${assetRefId}.webp`,
    mimeType: 'image/webp',
    role: 'capture_original',
    sizeBytes,
    workspaceId,
  };
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
