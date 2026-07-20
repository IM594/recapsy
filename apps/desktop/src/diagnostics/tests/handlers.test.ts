import { describe, expect, it } from 'bun:test';
import { createMemoryStore } from '../../storage/index';
import { createDiagnosticsIpcHandlers } from '../handlers';

const now = '2026-07-18T00:00:00.000Z';
const workspaceId = 'workspace_1';

describe('diagnostics retention handlers', () => {
  it('executes the reviewed retention set only after the renderer explicitly invokes it', async () => {
    const store = createMemoryStore();
    await store.upsertAssetCacheRef({
      assetRefId: 'asset_1',
      availabilityState: 'available',
      cleanupState: 'retained',
      createdAt: '2026-06-01T00:00:00.000Z',
      hash: 'sha256:asset_1',
      localAccessKey: 'capture_1/screenshot.webp',
      mimeType: 'image/webp',
      role: 'capture_original',
      sizeBytes: 128,
      workspaceId,
    });
    await store.createOutboxJob({
      assetRefId: 'asset_1',
      createdAt: now,
      deviceId: 'device_1',
      id: 'job_1',
      idempotencyKey: 'idem_1',
      payloadHash: 'sha256:job_1',
      workspaceId,
    });
    await store.markOutboxJobTerminal('job_1', { now, reason: 'ocr_synced', state: 'synced' });
    const removed: string[] = [];
    const handlers = createDiagnosticsIpcHandlers({
      now: () => now,
      removeAsset: async (localAccessKey) => {
        removed.push(localAccessKey);
      },
      store,
      workspaceId,
    });

    const response = await handlers['diagnostics.runRetention']?.({ olderThanDays: 30 });

    expect(removed).toEqual(['capture_1/screenshot.webp']);
    expect(response).toEqual({
      data: {
        cleanedAssets: 1,
        failedAssets: 0,
        protectedAssets: 0,
        reclaimedBytes: 128,
        retriedInterruptedAssets: 0,
      },
      ok: true,
    });
  });

  it('returns a safe IPC error when retention storage fails', async () => {
    const store = createMemoryStore();
    store.recoverPendingAssetCleanup = async () => {
      throw new Error('/Users/alice/private-cleanup-state');
    };
    const handlers = createDiagnosticsIpcHandlers({
      now: () => now,
      removeAsset: async () => undefined,
      store,
      workspaceId,
    });

    const response = await handlers['diagnostics.runRetention']?.({ olderThanDays: 30 });

    expect(response).toEqual({
      error: { code: 'unknown', message: 'Local asset cleanup failed.' },
      ok: false,
    });
  });
});
