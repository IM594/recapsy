import {
  type DevAcceptanceAdmissionReason,
  type DevAcceptanceCapturePauseReason,
  type DevAcceptanceCaptureState,
  type DevAcceptanceDesktopStatus,
  DevAcceptanceDesktopStatusSchema,
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
  syncOldestActiveAgeSeconds?: number;
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
    schemaVersion: 1,
    runtimeInstanceId: input.runtimeInstanceId,
    workspaceId: input.workspaceId,
    observedAt: input.observedAt,
    acceptedCaptureInputPerMinute: input.snapshot.syncInputPerMinute,
    oldestActiveAgeSeconds: input.snapshot.syncOldestActiveAgeSeconds ?? null,
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
