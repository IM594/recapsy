import type { LocalCapturePolicyRule, PolicyCacheEntry, SettingsCache, SyncCursor } from './types';

export function clonePolicyCache(entry: PolicyCacheEntry): PolicyCacheEntry {
  return {
    ...entry,
    policy: {
      ...entry.policy,
      rules: entry.policy.rules.map((rule) => ({ ...rule })),
    },
  };
}

export function cloneLocalCapturePolicyRule(rule: LocalCapturePolicyRule): LocalCapturePolicyRule {
  return { ...rule };
}

export function cloneSyncCursor(cursor: SyncCursor): SyncCursor {
  return { ...cursor };
}

export function cloneSettingsCache(settings: SettingsCache): SettingsCache {
  return { ...settings, serverCapabilities: { ...settings.serverCapabilities } };
}
