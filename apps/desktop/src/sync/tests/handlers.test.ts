import { describe, expect, it } from 'bun:test';
import { createMemoryStore } from '../../storage';
import { createSyncGate } from '../gate';
import { createSyncIpcHandlers } from '../handlers';

describe('sync ipc handlers', () => {
  it('returns safe gate status and routes explicit resume and terminal recovery', async () => {
    const store = createMemoryStore();
    const gate = createSyncGate();
    gate.pause('provider_auth_failed', '2026-07-27T00:00:00.000Z');
    let resumeCalls = 0;
    let requeueCalls = 0;
    const handlers = createSyncIpcHandlers({
      getGateStatus: () => gate.getStatus(),
      requeueTerminalJobs: async () => {
        requeueCalls += 1;
        return 4;
      },
      resumeProviderSync: () => {
        resumeCalls += 1;
        gate.resume();
      },
      store,
      workspaceId: 'workspace_1',
    });

    await expect(handlers['sync.getSummary']?.({})).resolves.toMatchObject({
      data: {
        gate: { reason: 'provider_auth_failed', state: 'paused' },
      },
      ok: true,
    });
    await expect(handlers['sync.resume']?.({})).resolves.toEqual({
      data: { state: 'open' },
      ok: true,
    });
    await expect(handlers['sync.requeueTerminal']?.({})).resolves.toEqual({
      data: { requeuedJobs: 4 },
      ok: true,
    });
    expect(resumeCalls).toBe(1);
    expect(requeueCalls).toBe(1);
  });
});
