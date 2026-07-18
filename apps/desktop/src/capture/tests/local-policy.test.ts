import { describe, expect, it } from 'bun:test';
import { createMemoryStore } from '../../storage';
import { createLocalCapturePolicyManager } from '../local-policy';

const now = '2026-07-18T10:00:00.000Z';

describe('local capture policy manager', () => {
  it('adds an exact bundle block idempotently and reloads the active helper policy', async () => {
    const store = createMemoryStore();
    let reloads = 0;
    const manager = createLocalCapturePolicyManager({
      now: () => now,
      reloadPolicy: async () => {
        reloads += 1;
      },
      store,
    });

    const first = await manager.blockBundle(' com.example.PasswordManager ');
    const second = await manager.blockBundle('com.example.PasswordManager');

    expect(first).toEqual(second);
    expect(await manager.list()).toEqual([first]);
    expect(first).toMatchObject({
      action: 'block_capture',
      kind: 'bundle_id',
      pattern: 'com.example.PasswordManager',
      scope: 'local_user',
    });
    expect(reloads).toBe(2);
  });

  it('rejects non-bundle patterns before persisting or refreshing policy', async () => {
    const store = createMemoryStore();
    let reloads = 0;
    const manager = createLocalCapturePolicyManager({
      now: () => now,
      reloadPolicy: async () => {
        reloads += 1;
      },
      store,
    });

    await expect(manager.blockBundle('https://example.com/login')).rejects.toMatchObject({
      code: 'invalid_bundle_id',
    });
    expect(await manager.list()).toEqual([]);
    expect(reloads).toBe(0);
  });

  it('removes only an existing local rule and reloads policy after the change', async () => {
    const store = createMemoryStore();
    let reloads = 0;
    const manager = createLocalCapturePolicyManager({
      now: () => now,
      reloadPolicy: async () => {
        reloads += 1;
      },
      store,
    });
    const rule = await manager.blockBundle('com.example.Sensitive');

    expect(await manager.remove(rule.id)).toBe(true);
    expect(await manager.remove(rule.id)).toBe(false);
    expect(await manager.list()).toEqual([]);
    expect(reloads).toBe(2);
  });
});
