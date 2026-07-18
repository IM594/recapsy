import { createHash } from 'node:crypto';
import type { LocalCapturePolicyRule } from '../storage/index';

export type LocalCapturePolicyRuleStore = {
  deleteLocalCapturePolicyRule(id: string): Promise<boolean>;
  listLocalCapturePolicyRules(): Promise<LocalCapturePolicyRule[]>;
  upsertLocalCapturePolicyRule(rule: LocalCapturePolicyRule): Promise<LocalCapturePolicyRule>;
};

export type LocalCapturePolicyManager = {
  blockBundle(bundleId: string): Promise<LocalCapturePolicyRule>;
  list(): Promise<LocalCapturePolicyRule[]>;
  remove(ruleId: string): Promise<boolean>;
};

export type LocalCapturePolicyManagerOptions = {
  now(): string;
  reloadPolicy(): Promise<void>;
  store: LocalCapturePolicyRuleStore;
};

export class LocalCapturePolicyError extends Error {
  readonly name = 'LocalCapturePolicyError';

  constructor(readonly code: 'invalid_bundle_id') {
    super('A valid application bundle identifier is required.');
  }
}

export function createLocalCapturePolicyManager(
  options: LocalCapturePolicyManagerOptions,
): LocalCapturePolicyManager {
  return {
    async blockBundle(input) {
      const bundleId = input.trim();
      if (!isBundleIdentifier(bundleId)) {
        throw new LocalCapturePolicyError('invalid_bundle_id');
      }

      const existing = (await options.store.listLocalCapturePolicyRules()).find(
        (rule) => rule.pattern === bundleId,
      );
      const timestamp = options.now();
      const rule = await options.store.upsertLocalCapturePolicyRule({
        action: 'block_capture',
        createdAt: existing?.createdAt ?? timestamp,
        enabled: true,
        id: existing?.id ?? localRuleId(bundleId),
        kind: 'bundle_id',
        pattern: bundleId,
        scope: 'local_user',
        updatedAt: timestamp,
      });
      await options.reloadPolicy();
      return rule;
    },
    list() {
      return options.store.listLocalCapturePolicyRules();
    },
    async remove(ruleId) {
      const removed = await options.store.deleteLocalCapturePolicyRule(ruleId);
      if (removed) {
        await options.reloadPolicy();
      }
      return removed;
    },
  };
}

export function isBundleIdentifier(value: string): boolean {
  return (
    value.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9-]*(?:[.][A-Za-z0-9][A-Za-z0-9-]*)+$/.test(value)
  );
}

function localRuleId(bundleId: string): string {
  return `local:${createHash('sha256').update(bundleId, 'utf8').digest('hex').slice(0, 24)}`;
}
