import {
  type BackpressureConfig,
  type BackpressureReason,
  type OperationalStoreSnapshot,
  evaluateOperationalStoreBackpressure,
} from '../storage/index';

export type CaptureAdmissionStore = {
  getBackpressureSnapshot(workspaceId: string): Promise<OperationalStoreSnapshot>;
  verifyOperationalWrite(): Promise<void>;
};

export type CaptureAdmissionLifecycle = {
  setAutomaticPause(active: boolean): Promise<void>;
  setStoragePause(active: boolean): Promise<void>;
};

export type CaptureAdmissionReason =
  | BackpressureReason
  | 'asset_write_failed'
  | 'min_available_storage_reached'
  | 'queue_state_unavailable'
  | 'storage_state_unavailable';

export type CaptureAdmissionStatus = {
  active: boolean;
  reasons: readonly CaptureAdmissionReason[];
};

export type CaptureStorageAdmissionSnapshot = {
  availableBytes: number;
  writable: boolean;
};

export type CaptureStorageAdmissionOptions = {
  minAvailableBytes: number;
  probe(): Promise<CaptureStorageAdmissionSnapshot>;
  resumeAvailableBytes: number;
  verifyWrite(): Promise<void>;
};

export type CaptureAdmissionController = {
  getStatus(): CaptureAdmissionStatus;
  reconcile(): Promise<CaptureAdmissionStatus>;
  reportStorageFailure(): Promise<CaptureAdmissionStatus>;
  reportStorageWriteFailure(): Promise<CaptureAdmissionStatus>;
  start(): Promise<void>;
  stop(): void;
};

export type CaptureAdmissionControllerOptions = {
  backpressure: BackpressureConfig;
  clearIntervalFn?: (handle: unknown) => void;
  intervalMs?: number;
  lifecycle: CaptureAdmissionLifecycle;
  setIntervalFn?: (callback: () => void, delayMs: number) => unknown;
  storage?: CaptureStorageAdmissionOptions;
  store: CaptureAdmissionStore;
  workspaceId: string;
};

const DEFAULT_RECONCILIATION_INTERVAL_MS = 1000;
const INTAKE_RECOVERY_SAMPLES = 2;

/**
 * Owns automatic capture admission. Queue volume, retry pressure, logical
 * asset bytes, and physical storage are independent latches: each enters at
 * its high-risk water mark and recovers only at its own low-risk water mark.
 */
export function createCaptureAdmissionController(
  options: CaptureAdmissionControllerOptions,
): CaptureAdmissionController {
  return new StoreBackedCaptureAdmissionController(options);
}

class StoreBackedCaptureAdmissionController implements CaptureAdmissionController {
  private assetBytesBlocked = false;
  private automaticPauseApplied = false;
  private availableStorageBlocked = false;
  private intakeStorageBlocked = false;
  private intakeStorageFailureGeneration = 0;
  private intakeStorageHealthySamples = 0;
  private intakeStorageWriteVerifiedGeneration: number | undefined;
  private intervalHandle: unknown;
  private queueBlocked = false;
  private queueStateUnavailable = false;
  private retryBlocked = false;
  private reconciliationInFlight: Promise<CaptureAdmissionStatus> | undefined;
  private pauseTransitionTail: Promise<void> = Promise.resolve();
  private storagePauseApplied = false;
  private storageStateUnavailable = false;
  private storageWriteBlocked = false;
  private storageWriteFailureGeneration = 0;

  constructor(private readonly options: CaptureAdmissionControllerOptions) {}

  getStatus(): CaptureAdmissionStatus {
    const reasons: CaptureAdmissionReason[] = [
      ...(this.queueBlocked ? (['max_queued_jobs_reached'] as const) : []),
      ...(this.retryBlocked ? (['max_retrying_jobs_reached'] as const) : []),
      ...(this.assetBytesBlocked ? (['max_asset_bytes_reached'] as const) : []),
      ...(this.availableStorageBlocked ? (['min_available_storage_reached'] as const) : []),
      ...(this.storageWriteBlocked ? (['asset_write_failed'] as const) : []),
      ...(this.queueStateUnavailable ? (['queue_state_unavailable'] as const) : []),
      ...(this.storageStateUnavailable || this.intakeStorageBlocked
        ? (['storage_state_unavailable'] as const)
        : []),
    ];

    return { active: reasons.length > 0, reasons };
  }

  reconcile(): Promise<CaptureAdmissionStatus> {
    if (this.reconciliationInFlight) {
      return this.reconciliationInFlight;
    }

    const reconciliation = this.reconcileNow();
    this.reconciliationInFlight = reconciliation;
    void reconciliation.then(
      () => {
        if (this.reconciliationInFlight === reconciliation) {
          this.reconciliationInFlight = undefined;
        }
      },
      () => {
        if (this.reconciliationInFlight === reconciliation) {
          this.reconciliationInFlight = undefined;
        }
      },
    );
    return reconciliation;
  }

  async reportStorageFailure(): Promise<CaptureAdmissionStatus> {
    this.intakeStorageBlocked = true;
    this.intakeStorageHealthySamples = 0;
    this.intakeStorageFailureGeneration += 1;
    this.intakeStorageWriteVerifiedGeneration = undefined;
    await this.applyPauseCauses();
    return this.getStatus();
  }

  async reportStorageWriteFailure(): Promise<CaptureAdmissionStatus> {
    this.storageWriteFailureGeneration += 1;
    this.storageWriteBlocked = true;
    await this.applyPauseCauses();
    return this.getStatus();
  }

  private async reconcileNow(): Promise<CaptureAdmissionStatus> {
    await Promise.all([this.reconcileQueueSignals(), this.reconcileStorageSignals()]);
    await this.applyPauseCauses();
    return this.getStatus();
  }

  async start(): Promise<void> {
    await this.reconcile();
    if (this.intervalHandle !== undefined) {
      return;
    }

    const setIntervalFn =
      this.options.setIntervalFn ??
      ((callback: () => void, delayMs: number) => setInterval(callback, delayMs));
    this.intervalHandle = setIntervalFn(() => {
      void this.reconcile();
    }, this.options.intervalMs ?? DEFAULT_RECONCILIATION_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalHandle === undefined) {
      return;
    }

    const clearIntervalFn =
      this.options.clearIntervalFn ??
      ((handle: unknown) => clearInterval(handle as NodeJS.Timeout));
    clearIntervalFn(this.intervalHandle);
    this.intervalHandle = undefined;
  }

  private async reconcileQueueSignals(): Promise<void> {
    const intakeFailureGeneration = this.intakeStorageFailureGeneration;
    try {
      const snapshot = await this.options.store.getBackpressureSnapshot(this.options.workspaceId);
      const decision = evaluateOperationalStoreBackpressure(snapshot, this.options.backpressure);
      this.queueStateUnavailable = false;
      if (
        this.intakeStorageBlocked &&
        intakeFailureGeneration === this.intakeStorageFailureGeneration
      ) {
        this.intakeStorageHealthySamples += 1;
        if (
          this.intakeStorageHealthySamples >= INTAKE_RECOVERY_SAMPLES &&
          this.intakeStorageWriteVerifiedGeneration === intakeFailureGeneration
        ) {
          this.intakeStorageBlocked = false;
          this.intakeStorageHealthySamples = 0;
          this.intakeStorageWriteVerifiedGeneration = undefined;
        }
      }
      this.queueBlocked = updateUpperWaterMark(
        this.queueBlocked,
        decision.reasons.includes('max_queued_jobs_reached'),
        snapshot.queuedJobs <= this.options.backpressure.resumeQueuedJobs,
      );
      this.retryBlocked = updateUpperWaterMark(
        this.retryBlocked,
        decision.reasons.includes('max_retrying_jobs_reached'),
        snapshot.retryingJobs <= this.options.backpressure.resumeRetryingJobs,
      );
      this.assetBytesBlocked = updateUpperWaterMark(
        this.assetBytesBlocked,
        decision.reasons.includes('max_asset_bytes_reached'),
        snapshot.assetBytes <= this.options.backpressure.resumeAssetBytes,
      );
    } catch {
      this.queueStateUnavailable = true;
      this.intakeStorageHealthySamples = 0;
    }
  }

  private async reconcileStorageSignals(): Promise<void> {
    if (!this.options.storage) {
      return;
    }

    const writeFailureGeneration = this.storageWriteFailureGeneration;
    const intakeFailureGeneration = this.intakeStorageFailureGeneration;
    try {
      const snapshot = await this.options.storage.probe();
      this.storageStateUnavailable = false;
      this.availableStorageBlocked = updateLowerWaterMark(
        this.availableStorageBlocked,
        snapshot.availableBytes <= this.options.storage.minAvailableBytes,
        snapshot.availableBytes >= this.options.storage.resumeAvailableBytes,
      );
      if (!snapshot.writable) {
        if (!this.storageWriteBlocked) {
          this.storageWriteFailureGeneration += 1;
        }
        this.storageWriteBlocked = true;
      } else if (snapshot.availableBytes >= this.options.storage.resumeAvailableBytes) {
        const verifyAssetWriteFailure =
          this.storageWriteBlocked && writeFailureGeneration === this.storageWriteFailureGeneration;
        const verifyIntakeStorageFailure =
          this.intakeStorageBlocked &&
          intakeFailureGeneration === this.intakeStorageFailureGeneration &&
          this.intakeStorageWriteVerifiedGeneration !== intakeFailureGeneration;
        if (verifyAssetWriteFailure) {
          try {
            await this.options.storage.verifyWrite();
            if (writeFailureGeneration === this.storageWriteFailureGeneration) {
              this.storageWriteBlocked = false;
            }
          } catch {
            // Keep the asset write-failure latch closed until a later verification succeeds.
          }
        }
        if (verifyIntakeStorageFailure) {
          try {
            await this.options.store.verifyOperationalWrite();
            if (intakeFailureGeneration === this.intakeStorageFailureGeneration) {
              this.intakeStorageWriteVerifiedGeneration = intakeFailureGeneration;
            }
          } catch {
            // Keep the intake storage-failure latch closed until a later verification succeeds.
          }
        }
      }
    } catch {
      this.storageStateUnavailable = true;
    }
  }

  private async applyPauseCauses(): Promise<void> {
    const transition = this.pauseTransitionTail.then(async () => {
      const automaticPause = this.queueBlocked || this.retryBlocked || this.queueStateUnavailable;
      const storagePause =
        this.assetBytesBlocked ||
        this.availableStorageBlocked ||
        this.storageWriteBlocked ||
        this.storageStateUnavailable ||
        this.intakeStorageBlocked;

      if (automaticPause !== this.automaticPauseApplied) {
        await this.options.lifecycle.setAutomaticPause(automaticPause);
        this.automaticPauseApplied = automaticPause;
      }
      if (storagePause !== this.storagePauseApplied) {
        await this.options.lifecycle.setStoragePause(storagePause);
        this.storagePauseApplied = storagePause;
      }
    });
    this.pauseTransitionTail = transition.catch(() => undefined);
    await transition;
  }
}

function updateUpperWaterMark(active: boolean, highReached: boolean, lowReached: boolean): boolean {
  return active ? !lowReached : highReached;
}

function updateLowerWaterMark(active: boolean, lowReached: boolean, highReached: boolean): boolean {
  return active ? !highReached : lowReached;
}
