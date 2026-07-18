import { describe, expect, it } from 'bun:test';
import type { CapturePoliciesResult } from '../../server/index';
import { createMemoryStore } from '../../storage/index';
import {
  CapturePolicyActivationError,
  compileCapturePolicy,
  createCapturePolicyActivation,
} from '../policy';

const workspaceId = 'workspace_1';
const deviceId = 'device_1';
const fetchedAt = '2026-07-18T00:00:00.000Z';

describe('capture policy activation', () => {
  it('persists the complete workspace/device snapshot and includes non-relaxable local rules', async () => {
    const store = createMemoryStore();
    await store.upsertLocalCapturePolicyRule({
      action: 'block_capture',
      createdAt: fetchedAt,
      enabled: true,
      id: 'local-password-manager',
      kind: 'bundle_id',
      pattern: 'com.example.password-manager',
      scope: 'local_user',
      updatedAt: fetchedAt,
    });
    const activation = createCapturePolicyActivation({
      api: {
        async getCapturePolicies(): Promise<CapturePoliciesResult> {
          return remotePolicy({
            rules: [
              {
                action: 'block_capture',
                enabled: true,
                id: 'workspace-safari',
                kind: 'bundle_id',
                pattern: 'com.apple.Safari',
                scope: 'workspace_default',
              },
            ],
          });
        },
      },
      deviceId,
      now: () => fetchedAt,
      store,
      workspaceId,
    });

    const configuration = await activation.activate();
    const cached = await store.getPolicyCache(workspaceId, deviceId, { now: fetchedAt });

    expect(cached).toMatchObject({
      deviceId,
      expired: false,
      policy: {
        rules: [
          {
            id: 'workspace-safari',
            kind: 'bundle_id',
            pattern: 'com.apple.Safari',
          },
        ],
      },
      policyVersion: 'capture-policy-1',
      workspaceId,
    });
    expect(configuration.policy.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'workspace-safari' }),
        expect.objectContaining({
          action: 'block_capture',
          id: 'local-password-manager',
          pattern: 'com.example.password-manager',
          scope: 'local_user',
        }),
        expect.objectContaining({ id: 'hard:recapsy-desktop', scope: 'hard' }),
        expect.objectContaining({ id: 'hard:recapsy-capture', scope: 'hard' }),
      ]),
    );
    expect(configuration.policy.policyHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(configuration.maxConcurrentOcr).toBe(3);
    expect(cached?.maxConcurrentOcr).toBe(3);
  });

  it('rejects a server snapshot that impersonates a device-local user rule', async () => {
    const backingStore = createMemoryStore();
    const store = Object.create(backingStore) as typeof backingStore;
    let cacheWrites = 0;
    store.setPolicyCache = async (entry) => {
      cacheWrites += 1;
      return backingStore.setPolicyCache(entry);
    };
    const activation = createCapturePolicyActivation({
      api: {
        async getCapturePolicies(): Promise<CapturePoliciesResult> {
          return remotePolicy({
            rules: [
              {
                action: 'block_capture',
                enabled: true,
                id: 'remote-local-rule',
                kind: 'bundle_id',
                pattern: 'com.example.sensitive',
                scope: 'local_user',
              },
            ],
          });
        },
      },
      deviceId,
      now: () => fetchedAt,
      store,
      workspaceId,
    });

    await expect(activation.activate()).rejects.toMatchObject({ code: 'policy_invalid_scope' });
    expect(cacheWrites).toBe(0);
    expect(await backingStore.getPolicyCache(workspaceId, deviceId, { now: fetchedAt })).toBeNull();
  });

  it('preserves a known-good cache when a server snapshot impersonates a local rule', async () => {
    const store = createMemoryStore();
    await store.setPolicyCache({
      deviceId,
      fetchedAt,
      policy: remotePolicy({
        rules: [
          {
            action: 'block_capture',
            enabled: true,
            id: 'workspace-sensitive-app',
            kind: 'bundle_id',
            pattern: 'com.example.sensitive',
            scope: 'workspace_default',
          },
        ],
      }).capturePolicy.policy,
      policySnapshotId: 'known_good_snapshot',
      policyVersion: 'known-good-policy',
      ttlSeconds: 3600,
      workspaceId,
    });
    const invalidActivation = createCapturePolicyActivation({
      api: {
        async getCapturePolicies(): Promise<CapturePoliciesResult> {
          return remotePolicy({
            rules: [
              {
                action: 'block_capture',
                enabled: true,
                id: 'remote-local-rule',
                kind: 'bundle_id',
                pattern: 'com.example.other-sensitive',
                scope: 'local_user',
              },
            ],
          });
        },
      },
      deviceId,
      now: () => fetchedAt,
      store,
      workspaceId,
    });

    await expect(invalidActivation.activate()).rejects.toMatchObject({
      code: 'policy_invalid_scope',
    });
    expect(await store.getPolicyCache(workspaceId, deviceId, { now: fetchedAt })).toMatchObject({
      policySnapshotId: 'known_good_snapshot',
      policyVersion: 'known-good-policy',
    });

    const offlineActivation = createCapturePolicyActivation({
      api: {
        async getCapturePolicies(): Promise<CapturePoliciesResult> {
          throw new Error('network unavailable');
        },
      },
      deviceId,
      now: () => '2026-07-18T00:00:30.000Z',
      store,
      workspaceId,
    });

    await expect(offlineActivation.activate()).resolves.toMatchObject({
      policy: {
        rules: expect.arrayContaining([expect.objectContaining({ id: 'workspace-sensitive-app' })]),
        version: 'known-good-policy',
      },
    });
  });

  it('uses only an unexpired cache when policy refresh is unavailable', async () => {
    const store = createMemoryStore();
    await store.setPolicyCache({
      deviceId,
      fetchedAt,
      policy: remotePolicy().capturePolicy.policy,
      policySnapshotId: 'snapshot_1',
      policyVersion: 'capture-policy-1',
      ttlSeconds: 60,
      workspaceId,
    });
    const activation = createCapturePolicyActivation({
      api: {
        async getCapturePolicies(): Promise<CapturePoliciesResult> {
          throw new Error('network unavailable');
        },
      },
      deviceId,
      now: () => '2026-07-18T00:00:30.000Z',
      store,
      workspaceId,
    });

    await expect(activation.activate()).resolves.toMatchObject({
      policy: { version: 'capture-policy-1' },
    });
  });

  it('fails closed when refresh fails and the only device-specific cache is expired', async () => {
    const store = createMemoryStore();
    await store.setPolicyCache({
      deviceId,
      fetchedAt,
      policy: remotePolicy().capturePolicy.policy,
      policySnapshotId: 'snapshot_1',
      policyVersion: 'capture-policy-1',
      ttlSeconds: 60,
      workspaceId,
    });
    const activation = createCapturePolicyActivation({
      api: {
        async getCapturePolicies(): Promise<CapturePoliciesResult> {
          throw new Error('network unavailable');
        },
      },
      deviceId,
      now: () => '2026-07-18T00:01:01.000Z',
      store,
      workspaceId,
    });

    await expect(activation.activate()).rejects.toBeInstanceOf(CapturePolicyActivationError);
    await expect(activation.activate()).rejects.toMatchObject({ code: 'policy_unavailable' });
  });

  it('applies a fresh stricter policy even when the offline cache cannot be persisted', async () => {
    const backingStore = createMemoryStore();
    await backingStore.setPolicyCache({
      deviceId,
      fetchedAt,
      policy: remotePolicy().capturePolicy.policy,
      policySnapshotId: 'old_snapshot',
      policyVersion: 'old_policy',
      ttlSeconds: 3600,
      workspaceId,
    });
    const store = Object.create(backingStore) as typeof backingStore;
    store.setPolicyCache = async () => {
      throw new Error('SQLite unavailable');
    };
    const activation = createCapturePolicyActivation({
      api: {
        async getCapturePolicies(): Promise<CapturePoliciesResult> {
          return remotePolicy({
            rules: [
              {
                action: 'block_capture',
                enabled: true,
                id: 'new-block',
                kind: 'bundle_id',
                pattern: 'com.example.sensitive',
                scope: 'workspace_default',
              },
            ],
          });
        },
      },
      deviceId,
      now: () => fetchedAt,
      store,
      workspaceId,
    });

    await expect(activation.activate()).resolves.toMatchObject({
      policy: {
        rules: expect.arrayContaining([expect.objectContaining({ id: 'new-block' })]),
      },
    });
  });

  it('reduces matching policy actions monotonically, so an allow rule cannot loosen a hard block', () => {
    const policy = compileCapturePolicy({
      policy: {
        axTextUploadEnabled: false,
        defaultAction: 'allow',
        paused: false,
        rules: [
          {
            action: 'allow',
            enabled: true,
            id: 'workspace-attempted-allow',
            kind: 'bundle_id',
            pattern: 'one.recapsy.desktop',
            scope: 'workspace_default',
          },
        ],
      },
      version: 'capture-policy-1',
    });

    expect(policy.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'block_capture',
          id: 'hard:recapsy-desktop',
          pattern: 'one.recapsy.desktop',
        }),
      ]),
    );
  });
});

function remotePolicy(
  overrides: Partial<CapturePoliciesResult['capturePolicy']['policy']> = {},
): CapturePoliciesResult {
  const policy = {
    axTextUploadEnabled: false as const,
    defaultAction: 'allow' as const,
    paused: false,
    rules: [],
    ...overrides,
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
      axTextUploadEnabled: policy.axTextUploadEnabled,
      defaultAction: policy.defaultAction,
      expiresAt: '2026-07-18T06:00:00.000Z',
      id: 'snapshot_1',
      paused: policy.paused,
      policy,
      rules: policy.rules,
      ttlSeconds: 3600,
      version: 'capture-policy-1',
    },
    deliveryPolicy: { maxConcurrentOcr: 3 },
    deviceId,
    generatedAt: fetchedAt,
    storagePolicy: {
      allowLongTermRemoteOriginal: false,
      authoritativeOriginalLocation: 'local_device',
    },
    workspaceId,
  };
}
