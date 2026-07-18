import type { IpcError } from './errors';

export type SafeSessionSummary = {
  state: 'signed_out' | 'signed_in' | 'expired';
  userId?: string;
  expiresAt?: string;
  workspaces: WorkspaceSummaryDto[];
};

export type RuntimeStatusDto = {
  status: 'starting' | 'running' | 'paused' | 'stopping' | 'stopped';
  menuBarActive: boolean;
  capturePaused: boolean;
  capturePauseReason?: 'user' | 'backpressure' | 'storage' | 'policy' | 'permission';
  network: 'online' | 'offline' | 'unknown';
  helper: {
    status: 'not_started' | 'starting' | 'ready' | 'degraded' | 'stopped';
    version?: string;
    lastHeartbeatAt?: string;
  };
};

export type WorkspaceSummaryDto = {
  id: string;
  displayName: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  current: boolean;
  quota: {
    capturesUsed: number;
    capturesLimit: number | null;
  };
  capabilities: WorkspaceCapabilitiesDto;
};

export type WorkspaceCapabilitiesDto = {
  capture: boolean;
  sync: boolean;
  ocr: boolean;
  timeline: boolean;
  search: boolean;
};

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

export type AppWindowActionResultDto = {
  shown: true;
};

export type CaptureEventSummaryDto = {
  id: string;
  observedAt: string;
  state: 'accepted' | 'skipped' | 'blocked' | 'failed';
  reason?: string;
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
};

export type OcrJobSummaryDto = {
  id: string;
  state: 'queued' | 'uploading' | 'processing' | 'completed' | 'failed' | 'cancelled';
  captureId?: string;
  provider: {
    configured: boolean;
    available: boolean;
  };
  cleanupState: 'not_started' | 'pending' | 'cleaned' | 'failed';
  createdAt: string;
  updatedAt: string;
  lastError?: IpcError;
};

export type TimelineQueryRequestDto = {
  cursor?: string;
  limit?: number;
  range?: {
    from?: string;
    to?: string;
  };
};

export type TimelineItemDto = {
  id: string;
  capturedAt: string;
  sourceApp?: string;
  title?: string;
  snippet?: string;
  ocrJobId?: string;
};

export type TimelineQueryResponseDto = {
  items: TimelineItemDto[];
  nextCursor?: string;
  incomplete: boolean;
};

export type SearchQueryRequestDto = {
  query: string;
  cursor?: string;
  limit?: number;
};

export type SearchResultDto = {
  id: string;
  capturedAt: string;
  sourceApp?: string;
  title?: string;
  snippet: string;
  score?: number;
};

export type SearchQueryResponseDto = {
  items: SearchResultDto[];
  nextCursor?: string;
  incomplete: boolean;
};

export type SettingsRuntimeDto = {
  capture: {
    enabled: boolean;
    schedule: 'disabled' | 'available';
  };
  diagnostics: {
    enabled: boolean;
  };
};

export type DiagnosticsLogEntryDto = {
  id: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  occurredAt: string;
  errorCode?: string;
};

export type DiagnosticsBundleDto = {
  id: string;
  createdAt: string;
  containsImages: false;
  containsOcrText: false;
  redacted: true;
};

export type RetentionPreviewDto = {
  cutoffAt: string;
  eligibleAssets: number;
  evaluatedAssets: number;
  olderThanDays: number;
  protectedAssets: number;
  reclaimableBytes: number;
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
