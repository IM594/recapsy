import type { IpcError } from './errors';

export type CaptureStatusDto = {
  state: 'idle' | 'capturing' | 'paused' | 'blocked' | 'degraded';
  paused: boolean;
  pauseReason?: 'user' | 'backpressure' | 'storage' | 'policy' | 'permission';
  permissions: {
    screenRecording: 'granted' | 'denied' | 'not_determined' | 'unknown';
    accessibility: 'granted' | 'denied' | 'not_determined' | 'unknown';
  };
  recentEventCount: number;
  admission?: {
    active: boolean;
    reasons: string[];
  };
  policy?: {
    hash: string;
    version: string;
  };
  lastError?: IpcError;
};

export type PermissionStatusDto = {
  screenRecording: 'granted' | 'denied' | 'not_determined' | 'unknown';
  accessibility: 'granted' | 'denied' | 'not_determined' | 'unknown';
  screenRecordingRequired: boolean;
  accessibilityRequired: boolean;
};

export type PrivacySettingsOpenResultDto = {
  opened: true;
};

export type LocalCapturePolicyRuleDto = {
  id: string;
  bundleId: string;
  enabled: boolean;
};

export type LocalCapturePolicyRulesDto = {
  rules: LocalCapturePolicyRuleDto[];
};

export type SyncQueueSummaryDto = {
  pending: number;
  processing: number;
  syncing: number;
  retrying: number;
  blocked: number;
  failed: number;
  inputPerMinute: number;
  completedPerMinute: number;
  oldestActiveAgeSeconds?: number;
  workerCapacity?: {
    activeWorkers: number;
    localMaxWorkers: number;
    serverMaxConcurrentOcr: number;
  };
  backpressure?: {
    active: boolean;
    reasons: string[];
  };
  nextRetryAt?: string;
  lastError?: IpcError;
  gate: SyncGateStatusDto;
};

export type SyncGateStatusDto =
  | { state: 'open' }
  | {
      state: 'paused' | 'half_open';
      reason: 'provider_auth_failed' | 'provider_configuration_invalid';
      pausedAt: string;
      nextProbeAt: string;
    };

export type SyncTerminalRecoveryDto = {
  requeuedJobs: number;
};

export type RetentionPreviewDto = {
  cutoffAt: string;
  eligibleAssets: number;
  evaluatedAssets: number;
  olderThanDays: number;
  protectedAssets: number;
  reclaimableBytes: number;
};

export type RetentionExecutionDto = {
  cleanedAssets: number;
  failedAssets: number;
  protectedAssets: number;
  reclaimedBytes: number;
  retriedInterruptedAssets: number;
};

export type RendererSafeDtoResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      issues: string[];
    };

const UNSAFE_FIELD_PATTERN =
  /(token|secret|password|credential|apiKey|api_key|refreshToken|refresh_token|path|rawPayload|helperPipe|sqlite|child_process|^fs$)/i;
const LOCAL_ABSOLUTE_PATH_PATTERN = /^(\/Users\/|\/private\/|\/var\/|[A-Za-z]:\\)/;

export function assertRendererSafeDto(value: unknown): RendererSafeDtoResult {
  const issues = collectUnsafeDtoIssues(value, []);

  if (issues.length === 0) {
    return { ok: true };
  }

  return {
    issues,
    ok: false,
  };
}

function collectUnsafeDtoIssues(value: unknown, path: string[]): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectUnsafeDtoIssues(item, [...path, String(index)]));
  }

  if (typeof value === 'string' && LOCAL_ABSOLUTE_PATH_PATTERN.test(value)) {
    const label = path.at(-1) ?? 'value';
    return [`${label} contains a local absolute path`];
  }

  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([key, entry]) => {
    if (UNSAFE_FIELD_PATTERN.test(key)) {
      return [`${key} is not renderer-safe`];
    }

    return collectUnsafeDtoIssues(entry, [...path, key]);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
