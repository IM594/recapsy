import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCapturePolicyController } from '../../src/capture/index';
import type { CapturePoliciesResult } from '../../src/server/index';
import { createSqliteStore } from '../../src/storage/index';
import { createBunSqliteDatabase } from '../../src/storage/sqlite/bun';

const workspaceId = 'workspace_1';
const deviceId = 'device_1';
const now = '2026-07-18T00:00:00.000Z';

describe('desktop privacy policy persistence', () => {
  it('restores app, domain, and website-family rules after reopening SQLite', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'recapsy-policy-'));
    const databasePath = path.join(root, 'profile.sqlite');
    const configured: Array<{ rules: Array<{ kind: string; pattern: string }> }> = [];

    const createController = (
      store: Parameters<typeof createCapturePolicyController>[0]['store'],
    ) =>
      createCapturePolicyController({
        api: {
          async getCapturePolicies(): Promise<CapturePoliciesResult> {
            return remotePolicy();
          },
        },
        async configure(policy) {
          configured.push(policy);
        },
        deviceId,
        now: () => now,
        store,
        workspaceId,
      });

    let reopenedStore: ReturnType<typeof createSqliteStore> | undefined;
    try {
      const firstStore = createSqliteStore({
        database: createBunSqliteDatabase(databasePath),
      });
      await firstStore.initialize();
      const firstController = createController(firstStore);
      await firstController.activate();
      await firstController.addLocalRule({ kind: 'bundle_id', pattern: 'com.example.ChatGPT' });
      await firstController.addLocalRule({ kind: 'domain', pattern: 'github.com' });
      await firstController.addLocalRule({ kind: 'domain_family', pattern: 'openrouter.ai' });
      firstStore.close();

      reopenedStore = createSqliteStore({
        database: createBunSqliteDatabase(databasePath),
      });
      await reopenedStore.initialize();
      const reopenedController = createController(reopenedStore);
      const configuration = await reopenedController.activate();
      const ruleKeys = configuration.policy.rules.map((rule) => `${rule.kind}:${rule.pattern}`);

      expect(ruleKeys).toEqual(
        expect.arrayContaining([
          'bundle_id:com.example.ChatGPT',
          'domain:github.com',
          'domain_family:openrouter.ai',
        ]),
      );
      expect(await reopenedController.listLocalRules()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'bundle_id', pattern: 'com.example.ChatGPT' }),
          expect.objectContaining({ kind: 'domain', pattern: 'github.com' }),
          expect.objectContaining({ kind: 'domain_family', pattern: 'openrouter.ai' }),
        ]),
      );
      expect(configured.at(-1)?.rules.map((rule) => `${rule.kind}:${rule.pattern}`)).toEqual(
        expect.arrayContaining([
          'bundle_id:com.example.ChatGPT',
          'domain:github.com',
          'domain_family:openrouter.ai',
        ]),
      );
    } finally {
      reopenedStore?.close();
      rmSync(root, { force: true, recursive: true });
    }
  });
});

function remotePolicy(): CapturePoliciesResult {
  const policy = {
    axTextUploadEnabled: false as const,
    defaultAction: 'allow' as const,
    paused: false,
    rules: [],
  };

  return {
    axAllowlist: {
      axTextUploadEnabled: false,
      enabled: false,
      reason: 'ax_text_upload_disabled',
      status: 'disabled',
      workspaceId,
    },
    capturePolicy: {
      actionCounts: {},
      axTextUploadEnabled: false,
      defaultAction: 'allow',
      expiresAt: '2026-07-18T06:00:00.000Z',
      id: 'snapshot_1',
      paused: false,
      policy,
      rules: [],
      ttlSeconds: 3600,
      version: 'capture-policy-1',
    },
    deliveryPolicy: { maxConcurrentOcr: 3 },
    deviceId,
    generatedAt: now,
    storagePolicy: {
      allowLongTermRemoteOriginal: false,
      authoritativeOriginalLocation: 'local_device',
    },
    workspaceId,
  };
}
