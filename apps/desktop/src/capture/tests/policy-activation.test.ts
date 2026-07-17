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
        expect.objectContaining({ id: 'hard:recapsy-desktop', scope: 'hard' }),
        expect.objectContaining({ id: 'hard:recapsy-capture', scope: 'hard' }),
      ]),
    );
    expect(configuration.policy.policyHash).toMatch(/^sha256:[a-f0-9]{64}$/);
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
    deviceId,
    generatedAt: fetchedAt,
    storagePolicy: {
      allowLongTermRemoteOriginal: false,
      authoritativeOriginalLocation: 'local_device',
    },
    workspaceId,
  };
}
