import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type {
  CaptureDefaultPolicy,
  CapturePolicyRule,
  LocalCapturePolicyRuleKind,
} from '@recapsy/contracts';
import type { HelperCapturePolicy, HelperCapturePolicyRule } from '../helper/index';
import type { CapturePoliciesResult } from '../server/index';
import type { LocalCapturePolicyRule, PolicyCacheEntry } from '../storage/index';
import type { CapturePolicyCacheStore } from './store';

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

export type CapturePolicyConfiguration = {
  maxConcurrentOcr: number;
  policy: CompiledCapturePolicy;
  refreshAfterMs?: number;
};

export type CapturePolicySnapshot =
  | { status: 'blocked' }
  | { status: 'activating' }
  | { configuration?: CapturePolicyConfiguration; status: 'inactive' }
  | { configuration: CapturePolicyConfiguration; status: 'active' };

export type CapturePolicyIdentity = {
  deviceId: string;
  workspaceId: string;
};

export type CapturePolicyController = {
  addLocalRule(input: {
    kind: LocalCapturePolicyRuleKind;
    pattern: string;
  }): Promise<LocalCapturePolicyRule>;
  activate(): Promise<CapturePolicyConfiguration>;
  blockBundle(bundleId: string): Promise<LocalCapturePolicyRule>;
  deactivate(): void;
  getSnapshot(): CapturePolicySnapshot;
  listLocalRules(): Promise<LocalCapturePolicyRule[]>;
  removeLocalRule(ruleId: string): Promise<boolean>;
  refresh(): Promise<CapturePolicyConfiguration>;
  subscribe(listener: (snapshot: CapturePolicySnapshot) => Promise<void> | void): () => void;
};

export type CapturePolicyControllerOptions = {
  api: Pick<
    {
      getCapturePolicies(input: {
        workspaceId: string;
        deviceId: string;
      }): Promise<CapturePoliciesResult>;
    },
    'getCapturePolicies'
  >;
  configure(policy: CompiledCapturePolicy, identity: CapturePolicyIdentity): Promise<void>;
  deviceId: string;
  now(): string;
  clearTimeoutFn?(handle: unknown): void;
  setTimeoutFn?(callback: () => void, delayMs: number): unknown;
  store: CapturePolicyCacheStore;
  workspaceId: string;
};

export class CapturePolicyError extends Error {
  readonly name = 'CapturePolicyError';

  constructor(
    readonly code:
      | 'policy_cache_unavailable'
      | 'policy_invalid_scope'
      | 'policy_invalid_fields'
      | 'invalid_bundle_id'
      | 'invalid_domain'
      | 'policy_unavailable'
      | 'policy_requires_unavailable_context',
  ) {
    super(
      code === 'policy_cache_unavailable'
        ? 'Capture policy cache is unavailable.'
        : code === 'invalid_bundle_id'
          ? 'A valid application bundle identifier is required.'
          : code === 'invalid_domain'
            ? 'A valid hostname without a URL or path is required.'
            : code === 'policy_invalid_scope'
              ? 'Capture policy contains a rule with an invalid ownership scope.'
              : code === 'policy_invalid_fields'
                ? 'Capture policy contains unsupported control characters.'
                : code === 'policy_requires_unavailable_context'
                  ? 'Capture policy requires unavailable local context.'
                  : 'Capture policy is unavailable.',
    );
  }
}

export function createCapturePolicyController(
  options: CapturePolicyControllerOptions,
): CapturePolicyController {
  return new StoreBackedCapturePolicyController(options);
}

const DEFAULT_POLICY_REFRESH_MS = 60_000;

class PolicyControllerInactiveError extends Error {}

class StoreBackedCapturePolicyController implements CapturePolicyController {
  private activeSession: object | undefined;
  private refreshDrain: Promise<void> = Promise.resolve();
  private refreshTimer: unknown;
  private snapshot: CapturePolicySnapshot = { status: 'inactive' };
  private readonly listeners = new Set<(snapshot: CapturePolicySnapshot) => Promise<void> | void>();

  constructor(private readonly options: CapturePolicyControllerOptions) {}

  activate(): Promise<CapturePolicyConfiguration> {
    if (!this.activeSession) {
      this.activeSession = {};
      this.snapshot = { status: 'activating' };
      this.publish();
    }
    return this.queueRefresh(this.activeSession);
  }

  addLocalRule(input: {
    kind: LocalCapturePolicyRuleKind;
    pattern: string;
  }): Promise<LocalCapturePolicyRule> {
    const pattern = normalizeLocalRulePattern(input.kind, input.pattern);
    if (!pattern) {
      return Promise.reject(
        new CapturePolicyError(input.kind === 'bundle_id' ? 'invalid_bundle_id' : 'invalid_domain'),
      );
    }
    const session = this.activeSession;

    return this.enqueue(async () => {
      const existing = (await this.options.store.listLocalCapturePolicyRules()).find(
        (rule) => rule.kind === input.kind && rule.pattern === pattern,
      );
      const timestamp = this.options.now();
      const rule = await this.options.store.upsertLocalCapturePolicyRule({
        action: 'block_capture',
        createdAt: existing?.createdAt ?? timestamp,
        enabled: true,
        id: existing?.id ?? localRuleId(input.kind, pattern),
        kind: input.kind,
        pattern,
        scope: 'local_user',
        updatedAt: timestamp,
      });
      if (session) {
        this.assertActiveSession(session);
        await this.refreshActiveSession(session);
      }
      return cloneLocalRule(rule);
    });
  }

  blockBundle(input: string): Promise<LocalCapturePolicyRule> {
    return this.addLocalRule({ kind: 'bundle_id', pattern: input });
  }

  deactivate(): void {
    this.activeSession = undefined;
    this.clearRefreshTimer();
    this.snapshot = {
      ...(this.snapshot.status === 'active' ? { configuration: this.snapshot.configuration } : {}),
      status: 'inactive',
    };
    this.publish();
  }

  getSnapshot(): CapturePolicySnapshot {
    return clonePolicySnapshot(this.snapshot);
  }

  async listLocalRules(): Promise<LocalCapturePolicyRule[]> {
    return (await this.options.store.listLocalCapturePolicyRules()).map(cloneLocalRule);
  }

  removeLocalRule(ruleId: string): Promise<boolean> {
    const session = this.activeSession;
    return this.enqueue(async () => {
      const removed = await this.options.store.deleteLocalCapturePolicyRule(ruleId);
      if (!removed || !session) return removed;

      this.assertActiveSession(session);
      await this.refreshActiveSession(session);
      return removed;
    });
  }

  refresh(): Promise<CapturePolicyConfiguration> {
    const session = this.activeSession;
    if (!session) return Promise.reject(new CapturePolicyError('policy_unavailable'));
    return this.queueRefresh(session);
  }

  subscribe(listener: (snapshot: CapturePolicySnapshot) => Promise<void> | void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.refreshDrain.then(operation);
    this.refreshDrain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private queueRefresh(session: object): Promise<CapturePolicyConfiguration> {
    return this.enqueue(() => this.refreshActiveSession(session));
  }

  private async refreshActiveSession(session: object): Promise<CapturePolicyConfiguration> {
    this.assertActiveSession(session);
    try {
      const configuration = await refreshPolicy(this.options, () =>
        this.assertActiveSession(session),
      );
      this.assertActiveSession(session);
      this.snapshot = { configuration, status: 'active' };
      this.publish();
      this.assertActiveSession(session);
      this.scheduleRefresh(session, configuration.refreshAfterMs);
      return configuration;
    } catch (error) {
      if (this.activeSession === session) {
        this.snapshot = { status: 'blocked' };
        this.publish();
        this.assertActiveSession(session);
        this.scheduleRefresh(session);
      }
      throw error;
    }
  }

  private assertActiveSession(session: object): void {
    if (this.activeSession !== session) throw new PolicyControllerInactiveError();
  }

  private publish(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(snapshot)).catch(() => undefined);
      } catch {
        // A status observer must not compromise the controller's acknowledged state.
      }
    }
  }

  private scheduleRefresh(session: object, delayMs = DEFAULT_POLICY_REFRESH_MS): void {
    this.clearRefreshTimer();
    const setTimeoutFn =
      this.options.setTimeoutFn ?? ((callback, timeoutMs) => setTimeout(callback, timeoutMs));
    const handle = setTimeoutFn(() => {
      this.refreshTimer = undefined;
      if (this.activeSession !== session) return;
      void this.queueRefresh(session).catch(() => undefined);
    }, normalizeRefreshDelay(delayMs));
    this.refreshTimer = handle;
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
      (handle as { unref?: () => void }).unref?.();
    }
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer === undefined) return;
    const clearTimeoutFn =
      this.options.clearTimeoutFn ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
    clearTimeoutFn(this.refreshTimer);
    this.refreshTimer = undefined;
  }
}

async function refreshPolicy(
  options: CapturePolicyControllerOptions,
  assertActive: () => void,
): Promise<CapturePolicyConfiguration> {
  const candidate = await fetchOrReadCachedPolicy(options);
  assertActive();
  assertWorkspacePolicyOwnership(candidate.entry.policy);
  const localRules = await options.store.listLocalCapturePolicyRules();
  assertActive();
  const compiled = compileCapturePolicy({
    localRules,
    policy: candidate.entry.policy,
    version: candidate.entry.policyVersion,
  });

  if (compiled.rules.some(requiresUnavailableContext)) {
    throw new CapturePolicyError('policy_requires_unavailable_context');
  }

  if (candidate.cache) {
    try {
      await options.store.setPolicyCache(candidate.entry);
      assertActive();
    } catch {
      throw new CapturePolicyError('policy_cache_unavailable');
    }
  }

  await options.configure(compiled, {
    deviceId: options.deviceId,
    workspaceId: options.workspaceId,
  });
  assertActive();

  const configuration = {
    maxConcurrentOcr: normalizeMaxConcurrentOcr(candidate.entry.maxConcurrentOcr),
    policy: compiled,
    refreshAfterMs: policyRefreshAfterMs(
      candidate.entry.fetchedAt,
      candidate.entry.ttlSeconds,
      options.now(),
    ),
  };
  return configuration;
}

export function compileCapturePolicy(input: {
  localRules?: readonly LocalCapturePolicyRule[];
  policy: CaptureDefaultPolicy;
  version: string;
}): CompiledCapturePolicy {
  if (
    [...input.policy.rules, ...(input.localRules ?? [])].some(
      (rule) => rule.id.includes('\u0000') || rule.pattern.includes('\u0000'),
    )
  ) {
    throw new CapturePolicyError('policy_invalid_fields');
  }
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
  const canonicalJson = canonicalCapturePolicyJson(canonical);

  return {
    ...canonical,
    policyHash: `sha256:${createHash('sha256').update(canonicalJson, 'utf8').digest('hex')}`,
  };
}

export function canonicalCapturePolicyJson(
  policy: Pick<HelperCapturePolicy, 'defaultAction' | 'paused' | 'rules' | 'version'>,
): string {
  return JSON.stringify({
    defaultAction: policy.defaultAction,
    paused: policy.paused,
    rules: policy.rules.map((rule) => ({ ...rule })).sort(compareRules),
    version: policy.version,
  });
}

async function fetchOrReadCachedPolicy(
  options: CapturePolicyControllerOptions,
): Promise<{ cache: boolean; entry: PolicyCacheEntry }> {
  let response: CapturePoliciesResult;
  try {
    response = await options.api.getCapturePolicies({
      deviceId: options.deviceId,
      workspaceId: options.workspaceId,
    });
  } catch {
    return { cache: false, entry: await readUnexpiredCachedPolicy(options) };
  }

  if (
    response.workspaceId !== options.workspaceId ||
    response.deviceId !== options.deviceId ||
    response.capturePolicy.version.length === 0
  ) {
    return { cache: false, entry: await readUnexpiredCachedPolicy(options) };
  }
  const fetchedAt = options.now();
  const remainingTtlSeconds = onlineSnapshotRemainingTtlSeconds(
    response.capturePolicy.expiresAt,
    fetchedAt,
    response.capturePolicy.ttlSeconds,
  );
  if (remainingTtlSeconds === null) {
    return { cache: false, entry: await readUnexpiredCachedPolicy(options) };
  }
  assertWorkspacePolicyOwnership(response.capturePolicy.policy);

  return {
    cache: true,
    entry: {
      deviceId: options.deviceId,
      fetchedAt,
      policy: clonePolicy(response.capturePolicy.policy),
      policySnapshotId: response.capturePolicy.id,
      policyVersion: response.capturePolicy.version,
      ttlSeconds: remainingTtlSeconds,
      maxConcurrentOcr: response.deliveryPolicy.maxConcurrentOcr,
      workspaceId: options.workspaceId,
    },
  };
}

function onlineSnapshotRemainingTtlSeconds(
  expiresAt: string,
  now: string,
  declaredTtlSeconds: number,
): number | null {
  const remainingSeconds = Math.floor((Date.parse(expiresAt) - Date.parse(now)) / 1000);
  if (!Number.isFinite(remainingSeconds) || remainingSeconds < 1) {
    return null;
  }
  return Math.min(declaredTtlSeconds, remainingSeconds);
}

async function readUnexpiredCachedPolicy(
  options: CapturePolicyControllerOptions,
): Promise<PolicyCacheEntry> {
  const cached = await options.store.getPolicyCache(options.workspaceId, options.deviceId, {
    now: options.now(),
  });
  if (!cached || cached.expired) {
    throw new CapturePolicyError('policy_unavailable');
  }
  return cached;
}

function normalizeMaxConcurrentOcr(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 1;
}

function assertWorkspacePolicyOwnership(policy: CaptureDefaultPolicy): void {
  if (policy.rules.some((rule) => rule.scope !== 'workspace_default')) {
    throw new CapturePolicyError('policy_invalid_scope');
  }
}

function policyRefreshAfterMs(fetchedAt: string, ttlSeconds: number, now: string): number {
  const expiresAt = Date.parse(fetchedAt) + Math.max(1, ttlSeconds) * 1000;
  const remainingMs = expiresAt - Date.parse(now);
  return Math.max(1_000, Math.min(60 * 60 * 1000, Math.floor(remainingMs / 2)));
}

function normalizeRefreshDelay(value: number | undefined): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return DEFAULT_POLICY_REFRESH_MS;
  return Math.min(60 * 60 * 1000, Math.max(1_000, Math.floor(value as number)));
}

function clonePolicySnapshot(snapshot: CapturePolicySnapshot): CapturePolicySnapshot {
  if (snapshot.status === 'blocked') return snapshot;
  if (snapshot.status === 'activating') return snapshot;
  if (snapshot.status === 'active') {
    return { configuration: cloneConfiguration(snapshot.configuration), status: 'active' };
  }
  return snapshot.configuration
    ? { configuration: cloneConfiguration(snapshot.configuration), status: 'inactive' }
    : { status: 'inactive' };
}

function cloneConfiguration(configuration: CapturePolicyConfiguration): CapturePolicyConfiguration {
  return {
    maxConcurrentOcr: configuration.maxConcurrentOcr,
    policy: {
      ...configuration.policy,
      rules: configuration.policy.rules.map((rule) => ({ ...rule })),
    },
    ...(configuration.refreshAfterMs !== undefined
      ? { refreshAfterMs: configuration.refreshAfterMs }
      : {}),
  };
}

function cloneLocalRule(rule: LocalCapturePolicyRule): LocalCapturePolicyRule {
  return { ...rule };
}

function isBundleIdentifier(value: string): boolean {
  return (
    value.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9-]*(?:[.][A-Za-z0-9][A-Za-z0-9-]*)+$/.test(value)
  );
}

function isDomainPattern(value: string): boolean {
  if (value.length === 0 || value.length > 253 || value.includes('\u0000')) return false;
  if (value.includes('/') || value.includes(':') || value.includes('?') || value.includes('#')) {
    return false;
  }

  return value.split('.').every((label) => {
    return (
      label.length >= 1 &&
      label.length <= 63 &&
      /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
    );
  });
}

function normalizeLocalRulePattern(kind: LocalCapturePolicyRuleKind, input: string): string | null {
  if (typeof input !== 'string') return null;
  const pattern = input.trim();
  if (kind === 'bundle_id') return isBundleIdentifier(pattern) ? pattern : null;
  return isDomainPattern(pattern) ? pattern.toLowerCase() : null;
}

function localRuleId(kind: LocalCapturePolicyRuleKind, pattern: string): string {
  const hashInput = kind === 'bundle_id' ? pattern : `${kind}\u0000${pattern}`;
  return `local:${createHash('sha256').update(hashInput, 'utf8').digest('hex').slice(0, 24)}`;
}

function requiresUnavailableContext(rule: CompiledCapturePolicyRule): boolean {
  return (
    rule.enabled &&
    rule.action !== 'allow' &&
    !['app_name', 'bundle_id', 'domain', 'domain_family', 'pause'].includes(rule.kind)
  );
}

function compareRules(left: CompiledCapturePolicyRule, right: CompiledCapturePolicyRule): number {
  return Buffer.compare(
    Buffer.from(stableRuleKey(left), 'utf8'),
    Buffer.from(stableRuleKey(right), 'utf8'),
  );
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
