import {
  type DevAcceptanceAdmissionReason,
  type DevAcceptanceCapturePauseReason,
  type DevAcceptanceCaptureState,
  type DevAcceptanceDesktopStatus,
  DevAcceptanceDesktopStatusSchema,
  DevAcceptancePolicyVersionSchema,
  type DevAcceptanceSafeErrorCode,
  DevAcceptanceSafeErrorCodeSchema,
} from '@recapsy/contracts';

export type DesktopAcceptanceSnapshot = {
  captureState: DevAcceptanceCaptureState;
  capturePaused: boolean;
  capturePauseReasons: readonly DevAcceptanceCapturePauseReason[];
  captureAdmission: {
    active: boolean;
    reasons: readonly DevAcceptanceAdmissionReason[];
  };
  syncInputPerMinute: number;
  syncCompletedPerMinute: number;
  syncProcessing: number;
  syncPending: number;
  syncOldestActiveAgeSeconds?: number;
  capturePolicyVersion?: string;
  safeErrorCode?: string;
  syncWorkerCapacity: {
    activeWorkers: number;
    localMaxWorkers: number;
    serverMaxConcurrentOcr: number;
  };
};

export type DesktopAcceptanceProjectionInput = {
  runtimeInstanceId: string;
  workspaceId: string;
  observedAt: string;
  snapshot: DesktopAcceptanceSnapshot;
};

export function projectDesktopAcceptanceStatus(
  input: DesktopAcceptanceProjectionInput,
): DevAcceptanceDesktopStatus {
  return DevAcceptanceDesktopStatusSchema.parse({
    schemaVersion: 2,
    runtimeInstanceId: input.runtimeInstanceId,
    workspaceId: input.workspaceId,
    observedAt: input.observedAt,
    acceptedCaptureInputPerMinute: input.snapshot.syncInputPerMinute,
    completedPerMinute: input.snapshot.syncCompletedPerMinute,
    processing: input.snapshot.syncProcessing,
    pending: input.snapshot.syncPending,
    oldestActiveAgeSeconds: input.snapshot.syncOldestActiveAgeSeconds ?? null,
    policyVersion: toPolicyVersion(input.snapshot.capturePolicyVersion),
    safeErrorCode: toSafeErrorCode(input.snapshot.safeErrorCode),
    workerCapacity: { ...input.snapshot.syncWorkerCapacity },
    capture: {
      state: input.snapshot.captureState,
      paused: input.snapshot.capturePaused,
      pauseReasons: [...input.snapshot.capturePauseReasons],
    },
    admission: {
      active: input.snapshot.captureAdmission.active,
      reasons: [...input.snapshot.captureAdmission.reasons],
    },
  });
}

function toSafeErrorCode(value: string | undefined): DevAcceptanceSafeErrorCode | null {
  if (!value) return null;
  const parsed = DevAcceptanceSafeErrorCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : 'unknown';
}

function toPolicyVersion(value: string | undefined): string | null {
  if (!value) return null;
  return DevAcceptancePolicyVersionSchema.safeParse(value).success ? value : null;
}
