import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { CapturePoliciesResult } from '../../server/index';
import { type PolicyCacheEntry, createMemoryStore } from '../../storage/index';
import {
  CapturePolicyError,
  canonicalCapturePolicyJson,
  compileCapturePolicy,
  createCapturePolicyController,
} from '../policy';

const workspaceId = 'workspace_1';
const deviceId = 'device_1';
const fetchedAt = '2026-07-18T00:00:00.000Z';
const acknowledgePolicy = async (): Promise<void> => undefined;

describe('capture policy activation', () => {
  it('normalizes and persists a whole-domain local rule through the policy controller', async () => {
    const store = createMemoryStore();
    const configured: unknown[] = [];
    const controller = createCapturePolicyController({
      api: {
        async getCapturePolicies(): Promise<CapturePoliciesResult> {
          return remotePolicy();
        },
      },
      async configure(policy) {
        configured.push(policy);
      },
      deviceId,
      now: () => fetchedAt,
      store,
      workspaceId,
    });

    await controller.activate();
    const rule = await controller.addLocalRule({ kind: 'domain', pattern: ' GitHub.COM ' });

    expect(rule).toMatchObject({
      action: 'block_capture',
      kind: 'domain',
      pattern: 'github.com',
      scope: 'local_user',
    });
    expect(await store.listLocalCapturePolicyRules()).toEqual([rule]);
    expect(configured.at(-1)).toMatchObject({
      rules: expect.arrayContaining([expect.objectContaining({ pattern: 'github.com' })]),
    });
  });

  it('rejects a domain rule that is a URL instead of a hostname', async () => {
    const controller = createCapturePolicyController({
      api: {
        async getCapturePolicies(): Promise<CapturePoliciesResult> {
          return remotePolicy();
        },
      },
      configure: acknowledgePolicy,
      deviceId,
      now: () => fetchedAt,
      store: createMemoryStore(),
      workspaceId,
    });

    await expect(
      controller.addLocalRule({ kind: 'domain', pattern: 'https://github.com/private' }),
    ).rejects.toMatchObject({ code: 'invalid_domain' });
  });

  it('normalizes and persists a website-family local rule', async () => {
    const store = createMemoryStore();
    const controller = createCapturePolicyController({
      api: {
        async getCapturePolicies(): Promise<CapturePoliciesResult> {
          return remotePolicy();
        },
      },
      configure: acknowledgePolicy,
      deviceId,
      now: () => fetchedAt,
      store,
      workspaceId,
    });

    await controller.activate();
    const rule = await controller.addLocalRule({
      kind: 'domain_family',
      pattern: ' GitHub.COM ',
    });

    expect(rule).toMatchObject({
      action: 'block_capture',
      kind: 'domain_family',
      pattern: 'github.com',
      scope: 'local_user',
    });
    expect(await store.listLocalCapturePolicyRules()).toEqual([rule]);
  });

  it('matches the shared UTF-8 canonical policy fixture', () => {
    const fixture = JSON.parse(
      readFileSync(
        path.resolve(
          import.meta.dir,
          '../../../macos/Tests/CaptureCoreTests/Fixtures/PolicyCanonical/policy-canonical.json',
        ),
        'utf8',
      ),
    ) as PolicyCanonicalFixture;
    const compiled = compileCapturePolicy({
      localRules: fixture.input.localRules.map((rule) => ({
        ...rule,
        createdAt: fetchedAt,
        updatedAt: fetchedAt,
      })),
      policy: {
        axTextUploadEnabled: false,
        defaultAction: fixture.input.defaultAction,
        paused: fixture.input.paused,
        rules: fixture.input.workspaceRules,
      },
      version: fixture.input.version,
    });

    expect(compiled.rules.map((rule) => rule.id)).toEqual(fixture.expected.orderedRuleIds);
    expect(canonicalCapturePolicyJson(compiled)).toBe(fixture.expected.canonicalJson);
    expect(compiled.policyHash).toBe(fixture.expected.policyHash);
  });

  it('fails closed before canonical sorting when policy text contains NUL', () => {
    expect(() =>
      compileCapturePolicy({
        localRules: [],
        policy: remotePolicy({
          rules: [
            {
              action: 'block_capture',
              enabled: true,
              id: 'ambiguous\u0000rule',
              kind: 'bundle_id',
              pattern: 'com.example.safe',
              scope: 'workspace_default',
            },
          ],
        }).capturePolicy.policy,
        version: 'policy-nul',
      }),
    ).toThrowError(new CapturePolicyError('policy_invalid_fields'));
  });

  it('configures an exact domain redaction rule for the native context sampler', async () => {
    const configured: unknown[] = [];
    const controller = createCapturePolicyController({
      api: {
        async getCapturePolicies(): Promise<CapturePoliciesResult> {
          return remotePolicy({
            rules: [
              {
                action: 'redact_context',
                enabled: true,
                id: 'workspace-private-domain',
                kind: 'domain',
                pattern: 'private.example',
                scope: 'workspace_default',
              },
            ],
          });
        },
      },
      async configure(policy) {
        configured.push(policy);
      },
      deviceId,
      now: () => fetchedAt,
      store: createMemoryStore(),
      workspaceId,
    });

    const configuration = await controller.activate();

    expect(configuration.policy.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'domain', pattern: 'private.example' }),
      ]),
    );
    expect(configured).toHaveLength(1);
  });

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
    const controller = createCapturePolicyController({
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
      configure: acknowledgePolicy,
      deviceId,
      now: () => fetchedAt,
      store,
      workspaceId,
    });

    const configuration = await controller.activate();
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
    const controller = createCapturePolicyController({
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
      configure: acknowledgePolicy,
      deviceId,
      now: () => fetchedAt,
      store,
      workspaceId,
    });

    await expect(controller.activate()).rejects.toMatchObject({ code: 'policy_invalid_scope' });
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
    const invalidController = createCapturePolicyController({
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
      configure: acknowledgePolicy,
      deviceId,
      now: () => fetchedAt,
      store,
      workspaceId,
    });

    await expect(invalidController.activate()).rejects.toMatchObject({
      code: 'policy_invalid_scope',
    });
    expect(await store.getPolicyCache(workspaceId, deviceId, { now: fetchedAt })).toMatchObject({
      policySnapshotId: 'known_good_snapshot',
      policyVersion: 'known-good-policy',
    });

    const offlineController = createCapturePolicyController({
      api: {
        async getCapturePolicies(): Promise<CapturePoliciesResult> {
          throw new Error('network unavailable');
        },
      },
      configure: acknowledgePolicy,
      deviceId,
      now: () => '2026-07-18T00:00:30.000Z',
      store,
      workspaceId,
    });

    await expect(offlineController.activate()).resolves.toMatchObject({
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
    const controller = createCapturePolicyController({
      api: {
        async getCapturePolicies(): Promise<CapturePoliciesResult> {
          throw new Error('network unavailable');
        },
      },
      configure: acknowledgePolicy,
      deviceId,
      now: () => '2026-07-18T00:00:30.000Z',
      store,
      workspaceId,
    });

    await expect(controller.activate()).resolves.toMatchObject({
      policy: { version: 'capture-policy-1' },
    });
  });

  it('rejects an already-expired online snapshot and preserves the known-good cache', async () => {
    const store = createMemoryStore();
    await store.setPolicyCache({
      deviceId,
      fetchedAt,
      policy: remotePolicy({
        rules: [
          {
            action: 'block_capture',
            enabled: true,
            id: 'known-good-rule',
            kind: 'bundle_id',
            pattern: 'com.example.known-good',
            scope: 'workspace_default',
          },
        ],
      }).capturePolicy.policy,
      policySnapshotId: 'known-good-snapshot',
      policyVersion: 'known-good-policy',
      ttlSeconds: 3600,
      workspaceId,
    });
    const expiredOnline = remotePolicy();
    expiredOnline.capturePolicy.id = 'expired-online-snapshot';
    expiredOnline.capturePolicy.expiresAt = '2026-07-18T00:00:20.000Z';
    const controller = createCapturePolicyController({
      api: {
        async getCapturePolicies() {
          return expiredOnline;
        },
      },
      configure: acknowledgePolicy,
      deviceId,
      now: () => '2026-07-18T00:00:30.000Z',
      store,
      workspaceId,
    });

    await expect(controller.activate()).resolves.toMatchObject({
      policy: {
        rules: expect.arrayContaining([expect.objectContaining({ id: 'known-good-rule' })]),
        version: 'known-good-policy',
      },
    });
    expect(
      await store.getPolicyCache(workspaceId, deviceId, {
        now: '2026-07-18T00:00:30.000Z',
      }),
    ).toMatchObject({
      policySnapshotId: 'known-good-snapshot',
      policyVersion: 'known-good-policy',
    });
  });

  it('caps the local cache lifetime at the online snapshot absolute expiry', async () => {
    const store = createMemoryStore();
    const online = remotePolicy();
    online.capturePolicy.expiresAt = '2026-07-18T00:00:45.000Z';
    online.capturePolicy.ttlSeconds = 3600;
    const controller = createCapturePolicyController({
      api: {
        async getCapturePolicies() {
          return online;
        },
      },
      configure: acknowledgePolicy,
      deviceId,
      now: () => '2026-07-18T00:00:30.000Z',
      store,
      workspaceId,
    });

    await controller.activate();

    await expect(
      store.getPolicyCache(workspaceId, deviceId, { now: '2026-07-18T00:00:44.000Z' }),
    ).resolves.toMatchObject({ expired: false, ttlSeconds: 15 });
    await expect(
      store.getPolicyCache(workspaceId, deviceId, { now: '2026-07-18T00:00:46.000Z' }),
    ).resolves.toMatchObject({ expired: true, ttlSeconds: 15 });
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
    const controller = createCapturePolicyController({
      api: {
        async getCapturePolicies(): Promise<CapturePoliciesResult> {
          throw new Error('network unavailable');
        },
      },
      configure: acknowledgePolicy,
      deviceId,
      now: () => '2026-07-18T00:01:01.000Z',
      store,
      workspaceId,
    });

    await expect(controller.activate()).rejects.toBeInstanceOf(CapturePolicyError);
    await expect(controller.activate()).rejects.toMatchObject({ code: 'policy_unavailable' });
  });

  it('does not activate an online policy that cannot become the durable cache fact', async () => {
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
    let configureCalls = 0;
    const controller = createCapturePolicyController({
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
      async configure() {
        configureCalls += 1;
      },
      deviceId,
      now: () => fetchedAt,
      store,
      workspaceId,
    });

    await expect(controller.activate()).rejects.toMatchObject({ code: 'policy_cache_unavailable' });
    expect(configureCalls).toBe(0);
  });

  it('publishes a policy only after helper acknowledgement and rejects a failed acknowledgement', async () => {
    const store = createMemoryStore();
    let acknowledge: (() => void) | undefined;
    const acknowledgement = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const configured: Array<{ deviceId: string; policyVersion: string; workspaceId: string }> = [];
    const controller = createCapturePolicyController({
      api: {
        async getCapturePolicies(): Promise<CapturePoliciesResult> {
          return remotePolicy();
        },
      },
      async configure(policy, identity) {
        configured.push({
          deviceId: identity.deviceId,
          policyVersion: policy.version,
          workspaceId: identity.workspaceId,
        });
        await acknowledgement;
      },
      deviceId,
      now: () => fetchedAt,
      store,
      workspaceId,
    });

    let published = false;
    const refresh = controller.activate().then((configuration) => {
      published = true;
      return configuration;
    });
    for (let index = 0; index < 5; index += 1) await Promise.resolve();

    expect(published).toBe(false);
    expect(configured).toEqual([{ deviceId, policyVersion: 'capture-policy-1', workspaceId }]);
    acknowledge?.();
    await expect(refresh).resolves.toMatchObject({
      policy: { version: 'capture-policy-1' },
    });
    expect(published).toBe(true);

    const rejected = createCapturePolicyController({
      api: {
        async getCapturePolicies(): Promise<CapturePoliciesResult> {
          return remotePolicy();
        },
      },
      async configure() {
        throw new Error('helper policy mismatch');
      },
      deviceId,
      now: () => fetchedAt,
      store,
      workspaceId,
    });

    await expect(rejected.activate()).rejects.toThrow('helper policy mismatch');
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

  it('serializes refreshes and commits each validated candidate through ordinary storage', async () => {
    const backingStore = createMemoryStore();
    const writes: PolicyCacheEntry[] = [];
    const store = Object.create(backingStore) as typeof backingStore;
    store.setPolicyCache = async (entry) => {
      writes.push(entry);
      return backingStore.setPolicyCache(entry);
    };
    const responses: Array<(value: CapturePoliciesResult) => void> = [];
    const controller = createCapturePolicyController({
      api: {
        async getCapturePolicies(): Promise<CapturePoliciesResult> {
          return await new Promise((resolve) => responses.push(resolve));
        },
      },
      configure: acknowledgePolicy,
      deviceId,
      now: () => fetchedAt,
      store,
      workspaceId,
    });

    const first = controller.activate();
    while (responses.length < 1) await Promise.resolve();
    const second = controller.refresh();
    await Promise.resolve();
    expect(responses).toHaveLength(1);

    const firstResponse = remotePolicy();
    firstResponse.capturePolicy.id = 'snapshot_first';
    firstResponse.capturePolicy.version = 'policy-first';
    responses[0]?.(firstResponse);
    await first;
    while (responses.length < 2) await Promise.resolve();
    expect(writes.map((entry) => entry.policyVersion)).toEqual(['policy-first']);

    const secondResponse = remotePolicy({
      rules: [
        {
          action: 'block_capture',
          enabled: true,
          id: 'newer-sensitive-app',
          kind: 'bundle_id',
          pattern: 'com.example.sensitive',
          scope: 'workspace_default',
        },
      ],
    });
    secondResponse.capturePolicy.id = 'snapshot_second';
    secondResponse.capturePolicy.version = 'policy-second';
    responses[1]?.(secondResponse);
    await second;

    expect(writes.map((entry) => entry.policyVersion)).toEqual(['policy-first', 'policy-second']);
    await expect(
      backingStore.getPolicyCache(workspaceId, deviceId, { now: fetchedAt }),
    ).resolves.toMatchObject({
      policySnapshotId: 'snapshot_second',
      policyVersion: 'policy-second',
    });
  });

  it('owns the refresh timer and cancels it when deactivated', async () => {
    const timers: Array<() => void> = [];
    let clearCalls = 0;
    const controller = createCapturePolicyController({
      api: {
        async getCapturePolicies(): Promise<CapturePoliciesResult> {
          return remotePolicy();
        },
      },
      clearTimeoutFn: () => {
        clearCalls += 1;
      },
      configure: acknowledgePolicy,
      deviceId,
      now: () => fetchedAt,
      setTimeoutFn: (callback) => {
        timers.push(callback);
        return timers.length;
      },
      store: createMemoryStore(),
      workspaceId,
    });

    await controller.activate();
    expect(timers).toHaveLength(1);

    controller.deactivate();
    expect(clearCalls).toBe(1);
    expect(controller.getSnapshot()).toMatchObject({ status: 'inactive' });
  });

  it('does not commit an activation after its policy session is deactivated', async () => {
    const response = Promise.withResolvers<CapturePoliciesResult>();
    const store = createMemoryStore();
    let configureCalls = 0;
    const controller = createCapturePolicyController({
      api: {
        async getCapturePolicies(): Promise<CapturePoliciesResult> {
          return response.promise;
        },
      },
      async configure() {
        configureCalls += 1;
      },
      deviceId,
      now: () => fetchedAt,
      store,
      workspaceId,
    });

    const activation = controller.activate();
    controller.deactivate();
    response.resolve(remotePolicy());

    await expect(activation).rejects.toBeInstanceOf(Error);
    expect(configureCalls).toBe(0);
    expect(await store.getPolicyCache(workspaceId, deviceId, { now: fetchedAt })).toBeNull();
    expect(controller.getSnapshot()).toEqual({ status: 'inactive' });
  });

  it('does not fetch a refresh that was queued before the policy session was deactivated', async () => {
    const firstResponse = Promise.withResolvers<CapturePoliciesResult>();
    let fetches = 0;
    const controller = createCapturePolicyController({
      api: {
        async getCapturePolicies(): Promise<CapturePoliciesResult> {
          fetches += 1;
          return fetches === 1 ? firstResponse.promise : remotePolicy();
        },
      },
      configure: acknowledgePolicy,
      deviceId,
      now: () => fetchedAt,
      store: createMemoryStore(),
      workspaceId,
    });

    const first = controller.activate();
    while (fetches < 1) await Promise.resolve();
    const queued = controller.refresh();
    controller.deactivate();
    firstResponse.resolve(remotePolicy());

    await expect(first).rejects.toBeInstanceOf(Error);
    await expect(queued).rejects.toBeInstanceOf(Error);
    expect(fetches).toBe(1);
    expect(controller.getSnapshot()).toEqual({ status: 'inactive' });
  });

  it('publishes activating before the first helper acknowledgement, then publishes active', async () => {
    const response = Promise.withResolvers<CapturePoliciesResult>();
    const snapshots: string[] = [];
    const controller = createCapturePolicyController({
      api: {
        async getCapturePolicies(): Promise<CapturePoliciesResult> {
          return response.promise;
        },
      },
      configure: acknowledgePolicy,
      deviceId,
      now: () => fetchedAt,
      store: createMemoryStore(),
      workspaceId,
    });
    controller.subscribe((snapshot) => {
      snapshots.push(snapshot.status);
    });

    const activation = controller.activate();
    for (let index = 0; index < 5; index += 1) await Promise.resolve();

    expect(controller.getSnapshot()).toEqual({ status: 'activating' });
    expect(snapshots).toEqual(['activating']);

    response.resolve(remotePolicy());
    await expect(activation).resolves.toMatchObject({ policy: { version: 'capture-policy-1' } });
    expect(controller.getSnapshot()).toMatchObject({ status: 'active' });
    expect(snapshots).toEqual(['activating', 'active']);
  });

  it('owns local bundle rules and only configures an active policy session', async () => {
    const store = createMemoryStore();
    let fetches = 0;
    let configurations = 0;
    const controller = createCapturePolicyController({
      api: {
        async getCapturePolicies(): Promise<CapturePoliciesResult> {
          fetches += 1;
          return remotePolicy();
        },
      },
      async configure() {
        configurations += 1;
      },
      deviceId,
      now: () => fetchedAt,
      store,
      workspaceId,
    });

    const localRule = await controller.blockBundle(' com.example.PasswordManager ');

    expect(localRule).toMatchObject({
      action: 'block_capture',
      kind: 'bundle_id',
      pattern: 'com.example.PasswordManager',
      scope: 'local_user',
    });
    expect(await controller.listLocalRules()).toEqual([localRule]);
    expect(fetches).toBe(0);
    expect(configurations).toBe(0);

    await controller.activate();
    expect(fetches).toBe(1);
    expect(configurations).toBe(1);

    const duplicate = await controller.blockBundle('com.example.PasswordManager');
    expect(duplicate).toEqual(localRule);
    expect(fetches).toBe(2);
    expect(configurations).toBe(2);

    expect(await controller.removeLocalRule(localRule.id)).toBe(true);
    expect(fetches).toBe(3);
    expect(configurations).toBe(3);
    expect(await controller.listLocalRules()).toEqual([]);
  });

  it('rejects invalid bundle identifiers before persisting or contacting the policy service', async () => {
    const store = createMemoryStore();
    let fetches = 0;
    let configurations = 0;
    const controller = createCapturePolicyController({
      api: {
        async getCapturePolicies(): Promise<CapturePoliciesResult> {
          fetches += 1;
          return remotePolicy();
        },
      },
      async configure() {
        configurations += 1;
      },
      deviceId,
      now: () => fetchedAt,
      store,
      workspaceId,
    });

    await expect(controller.blockBundle('https://example.com/login')).rejects.toMatchObject({
      code: 'invalid_bundle_id',
    });
    expect(await controller.listLocalRules()).toEqual([]);
    expect(fetches).toBe(0);
    expect(configurations).toBe(0);
  });

  it('invalidates an in-flight local rule refresh without configuring or rescheduling', async () => {
    const pendingRefresh = Promise.withResolvers<CapturePoliciesResult>();
    let fetches = 0;
    let configurations = 0;
    let clearCalls = 0;
    const timers: Array<() => void> = [];
    const controller = createCapturePolicyController({
      api: {
        async getCapturePolicies(): Promise<CapturePoliciesResult> {
          fetches += 1;
          return fetches === 1 ? remotePolicy() : pendingRefresh.promise;
        },
      },
      clearTimeoutFn: () => {
        clearCalls += 1;
      },
      async configure() {
        configurations += 1;
      },
      deviceId,
      now: () => fetchedAt,
      setTimeoutFn: (callback) => {
        timers.push(callback);
        return timers.length;
      },
      store: createMemoryStore(),
      workspaceId,
    });
    await controller.activate();

    const mutation = controller.blockBundle('com.example.Sensitive');
    while (fetches < 2) await Promise.resolve();
    controller.deactivate();
    pendingRefresh.resolve(remotePolicy());

    await expect(mutation).rejects.toBeInstanceOf(Error);
    expect(configurations).toBe(1);
    expect(clearCalls).toBe(1);
    expect(timers).toHaveLength(1);
    expect(controller.getSnapshot()).toEqual({
      configuration: expect.any(Object),
      status: 'inactive',
    });
  });

  it('rejects an invalid candidate before cache commit and then processes the queued refresh', async () => {
    const backingStore = createMemoryStore();
    const writes: PolicyCacheEntry[] = [];
    const store = Object.create(backingStore) as typeof backingStore;
    store.setPolicyCache = async (entry) => {
      writes.push(entry);
      return backingStore.setPolicyCache(entry);
    };
    const responses: Array<(value: CapturePoliciesResult) => void> = [];
    const controller = createCapturePolicyController({
      api: {
        async getCapturePolicies(): Promise<CapturePoliciesResult> {
          return await new Promise((resolve) => responses.push(resolve));
        },
      },
      configure: acknowledgePolicy,
      deviceId,
      now: () => fetchedAt,
      store,
      workspaceId,
    });

    const invalid = controller.activate();
    while (responses.length < 1) await Promise.resolve();
    const queued = controller.refresh();
    const invalidResponse = remotePolicy({
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
    responses[0]?.(invalidResponse);
    await expect(invalid).rejects.toMatchObject({ code: 'policy_invalid_scope' });
    while (responses.length < 2) await Promise.resolve();
    expect(writes).toHaveLength(0);

    const validResponse = remotePolicy();
    validResponse.capturePolicy.id = 'snapshot_valid';
    validResponse.capturePolicy.version = 'policy-valid';
    responses[1]?.(validResponse);
    await queued;

    expect(writes.map((entry) => entry.policyVersion)).toEqual(['policy-valid']);
    await expect(
      backingStore.getPolicyCache(workspaceId, deviceId, { now: fetchedAt }),
    ).resolves.toMatchObject({
      policySnapshotId: 'snapshot_valid',
      policyVersion: 'policy-valid',
    });
  });
});

type PolicyCanonicalFixture = {
  input: {
    defaultAction: 'allow';
    localRules: Array<{
      action: 'block_capture';
      enabled: boolean;
      id: string;
      kind: 'bundle_id';
      pattern: string;
      scope: 'local_user';
    }>;
    paused: boolean;
    version: string;
    workspaceRules: Array<{
      action: 'block_capture';
      enabled: boolean;
      id: string;
      kind: 'bundle_id';
      pattern: string;
      scope: 'workspace_default';
    }>;
  };
  expected: {
    canonicalJson: string;
    orderedRuleIds: string[];
    policyHash: string;
  };
};

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
