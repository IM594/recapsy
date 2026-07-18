import { createHash } from 'node:crypto';
import type { CaptureDefaultPolicy, CapturePolicyRule } from '@recapsy/contracts';
import type { HelperCapturePolicy, HelperCapturePolicyRule } from '../helper/index';
import type { CapturePoliciesResult } from '../server/index';
import type { LocalCapturePolicyRule, PolicyCacheEntry, PolicyCacheRead } from '../storage/index';

const HARD_CAPTURE_RULES: readonly CompiledCapturePolicyRule[] = [
  {
    action: 'block_capture',
    enabled: true,
    id: 'hard:recapsy-capture',
    kind: 'bundle_id',
    pattern: 'one.recapsy.desktop.capture',
    scope: 'hard',
  },
  {
    action: 'block_capture',
    enabled: true,
    id: 'hard:recapsy-desktop',
    kind: 'bundle_id',
    pattern: 'one.recapsy.desktop',
    scope: 'hard',
  },
];

type CompiledCapturePolicyRule = HelperCapturePolicyRule;

export type CompiledCapturePolicy = HelperCapturePolicy;

export type CapturePolicyActivationConfiguration = {
  maxConcurrentOcr: number;
  policy: CompiledCapturePolicy;
  refreshAfterMs?: number;
};

export type CapturePolicyActivation = {
  activate(): Promise<CapturePolicyActivationConfiguration>;
};

type CapturePolicyCacheStore = {
  getPolicyCache(
    workspaceId: string,
    deviceId: string,
    options: { now: string },
  ): Promise<PolicyCacheRead | null>;
  setPolicyCache(entry: PolicyCacheEntry): Promise<PolicyCacheEntry>;
  listLocalCapturePolicyRules(): Promise<LocalCapturePolicyRule[]>;
};

export type CapturePolicyActivationOptions = {
  api: Pick<
    {
      getCapturePolicies(input: {
        workspaceId: string;
        deviceId: string;
      }): Promise<CapturePoliciesResult>;
    },
    'getCapturePolicies'
  >;
  deviceId: string;
  now(): string;
  onActivated?(configuration: CapturePolicyActivationConfiguration): void;
  store: CapturePolicyCacheStore;
  workspaceId: string;
};

export class CapturePolicyActivationError extends Error {
  readonly name = 'CapturePolicyActivationError';

  constructor(
    readonly code:
      | 'policy_invalid_scope'
      | 'policy_unavailable'
      | 'policy_requires_unavailable_context'
      | 'policy_stale',
  ) {
    super(
      code === 'policy_invalid_scope'
        ? 'Capture policy contains a rule with an invalid ownership scope.'
        : code === 'policy_requires_unavailable_context'
          ? 'Capture policy requires unavailable local context.'
          : code === 'policy_stale'
            ? 'Capture policy refresh was superseded by a newer snapshot.'
            : 'Capture policy is unavailable.',
    );
  }
}

export function createCapturePolicyActivation(
  options: CapturePolicyActivationOptions,
): CapturePolicyActivation {
  let activationGeneration = 0;
  let policyCacheWriteQueue: Promise<void> = Promise.resolve();

  const persistCurrentPolicyCache = (
    entry: PolicyCacheEntry,
    isCurrent: () => boolean,
  ): Promise<void> => {
    const write = policyCacheWriteQueue.then(async () => {
      if (!isCurrent()) {
        return;
      }

      try {
        await options.store.setPolicyCache(entry);
      } catch {
        // A current, validated server policy is safer than a stale cache. The
        // cache is only an offline fallback, never a prerequisite for applying
        // a stricter policy that has already been received.
      }
    });
    policyCacheWriteQueue = write.catch(() => undefined);
    return write;
  };

  return {
    async activate(): Promise<CapturePolicyActivationConfiguration> {
      const generation = ++activationGeneration;
      const isCurrent = () => generation === activationGeneration;
      const fetched = await fetchOrReadCachedPolicy(options, (entry) =>
        persistCurrentPolicyCache(entry, isCurrent),
      );
      if (!isCurrent()) {
        throw new CapturePolicyActivationError('policy_stale');
      }
      assertWorkspacePolicyOwnership(fetched.policy);
      const localRules = await options.store.listLocalCapturePolicyRules();
      if (!isCurrent()) {
        throw new CapturePolicyActivationError('policy_stale');
      }
      const compiled = compileCapturePolicy({
        localRules,
        policy: fetched.policy,
        version: fetched.policyVersion,
      });

      if (compiled.rules.some(requiresUnavailableContext)) {
        throw new CapturePolicyActivationError('policy_requires_unavailable_context');
      }

      if (!isCurrent()) {
        throw new CapturePolicyActivationError('policy_stale');
      }

      const configuration = {
        maxConcurrentOcr: normalizeMaxConcurrentOcr(fetched.maxConcurrentOcr),
        policy: compiled,
        refreshAfterMs: policyRefreshAfterMs(fetched.fetchedAt, fetched.ttlSeconds, options.now()),
      };
      options.onActivated?.(configuration);
      return configuration;
    },
  };
}

export function compileCapturePolicy(input: {
  localRules?: readonly LocalCapturePolicyRule[];
  policy: CaptureDefaultPolicy;
  version: string;
}): CompiledCapturePolicy {
  const rules: CompiledCapturePolicyRule[] = [
    ...input.policy.rules.map((rule) => toCompiledRule(rule)),
    ...(input.localRules ?? []).map((rule) => toCompiledRule(rule)),
    ...HARD_CAPTURE_RULES.map((rule) => ({ ...rule })),
  ].sort(compareRules);
  const canonical = {
    defaultAction: input.policy.defaultAction,
    paused: input.policy.paused,
    rules,
    version: input.version,
  };

  return {
    ...canonical,
    policyHash: `sha256:${createHash('sha256')
      .update(JSON.stringify(canonical), 'utf8')
      .digest('hex')}`,
  };
}

async function fetchOrReadCachedPolicy(
  options: CapturePolicyActivationOptions,
  persistPolicyCache: (entry: PolicyCacheEntry) => Promise<void>,
): Promise<PolicyCacheEntry> {
  let response: CapturePoliciesResult;
  try {
    response = await options.api.getCapturePolicies({
      deviceId: options.deviceId,
      workspaceId: options.workspaceId,
    });
  } catch {
    return await readUnexpiredCachedPolicy(options);
  }

  if (
    response.workspaceId !== options.workspaceId ||
    response.deviceId !== options.deviceId ||
    response.capturePolicy.version.length === 0
  ) {
    return await readUnexpiredCachedPolicy(options);
  }
  assertWorkspacePolicyOwnership(response.capturePolicy.policy);

  const entry: PolicyCacheEntry = {
    deviceId: options.deviceId,
    fetchedAt: options.now(),
    policy: clonePolicy(response.capturePolicy.policy),
    policySnapshotId: response.capturePolicy.id,
    policyVersion: response.capturePolicy.version,
    ttlSeconds: response.capturePolicy.ttlSeconds,
    maxConcurrentOcr: response.deliveryPolicy.maxConcurrentOcr,
    workspaceId: options.workspaceId,
  };

  await persistPolicyCache(entry);

  return entry;
}

async function readUnexpiredCachedPolicy(
  options: CapturePolicyActivationOptions,
): Promise<PolicyCacheEntry> {
  const cached = await options.store.getPolicyCache(options.workspaceId, options.deviceId, {
    now: options.now(),
  });
  if (!cached || cached.expired) {
    throw new CapturePolicyActivationError('policy_unavailable');
  }
  return cached;
}

function normalizeMaxConcurrentOcr(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 1;
}

function assertWorkspacePolicyOwnership(policy: CaptureDefaultPolicy): void {
  if (policy.rules.some((rule) => rule.scope !== 'workspace_default')) {
    throw new CapturePolicyActivationError('policy_invalid_scope');
  }
}

function policyRefreshAfterMs(fetchedAt: string, ttlSeconds: number, now: string): number {
  const expiresAt = Date.parse(fetchedAt) + Math.max(1, ttlSeconds) * 1000;
  const remainingMs = expiresAt - Date.parse(now);
  return Math.max(1_000, Math.min(60 * 60 * 1000, Math.floor(remainingMs / 2)));
}

function requiresUnavailableContext(rule: CompiledCapturePolicyRule): boolean {
  return (
    rule.enabled &&
    rule.action !== 'allow' &&
    !['app_name', 'bundle_id', 'pause'].includes(rule.kind)
  );
}

function compareRules(left: CompiledCapturePolicyRule, right: CompiledCapturePolicyRule): number {
  return stableRuleKey(left).localeCompare(stableRuleKey(right));
}

function stableRuleKey(rule: CompiledCapturePolicyRule): string {
  return [rule.scope, rule.id, rule.kind, rule.pattern, rule.action, rule.enabled ? '1' : '0'].join(
    '\u0000',
  );
}

function clonePolicy(policy: CaptureDefaultPolicy): CaptureDefaultPolicy {
  return {
    ...policy,
    rules: policy.rules.map(cloneRule),
  };
}

function toCompiledRule(rule: CapturePolicyRule): CompiledCapturePolicyRule {
  return {
    action: rule.action,
    enabled: rule.enabled,
    id: rule.id,
    kind: rule.kind,
    pattern: rule.pattern,
    scope: rule.scope,
  };
}

function cloneRule(rule: CapturePolicyRule): CapturePolicyRule {
  return { ...rule };
}
