import {
  type BackpressureConfig,
  type BackpressureReason,
  type OperationalStoreSnapshot,
  evaluateOperationalStoreBackpressure,
} from '../storage/index';

export type CaptureAdmissionStore = {
  getBackpressureSnapshot(): Promise<OperationalStoreSnapshot>;
  verifyOperationalWrite(): Promise<void>;
};

export type CaptureAdmissionReason =
  | BackpressureReason
  | 'asset_write_failed'
  | 'min_available_storage_reached'
  | 'queue_state_unavailable'
  | 'storage_state_unavailable';

export type CaptureAdmissionSnapshot = Readonly<{
  reasons: readonly CaptureAdmissionReason[];
}>;

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
  getStatus(): CaptureAdmissionSnapshot;
  reconcile(): Promise<CaptureAdmissionSnapshot>;
  reportStorageFailure(): Promise<CaptureAdmissionSnapshot>;
  reportStorageWriteFailure(): Promise<CaptureAdmissionSnapshot>;
  start(): Promise<void>;
  stop(): void;
};

export type CaptureAdmissionControllerOptions = {
  backpressure: BackpressureConfig;
  clearIntervalFn?: (handle: unknown) => void;
  intervalMs?: number;
  setIntervalFn?: (callback: () => void, delayMs: number) => unknown;
  storage?: CaptureStorageAdmissionOptions;
  store: CaptureAdmissionStore;
  onStatusChange?(status: CaptureAdmissionSnapshot): void | Promise<void>;
};

const DEFAULT_RECONCILIATION_INTERVAL_MS = 1000;
const INTAKE_RECOVERY_SAMPLES = 2;

type HealthyHealth = { state: 'healthy' };

type WatermarkHealth = HealthyHealth | { state: 'blocked' };

type OperationalSnapshotHealth = HealthyHealth | { state: 'unavailable' };

type DiskHealth = HealthyHealth | { state: 'low_capacity' } | { state: 'unavailable' };

type AssetWriteHealth =
  | HealthyHealth
  | {
      state: 'failed';
      failureIdentity: number;
      verification: 'required';
    };

type IntakeWriteHealth =
  | HealthyHealth
  | {
      state: 'failed';
      failureIdentity: number;
      healthySamples: number;
      verification: 'required' | 'confirmed';
    };

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
  private assetBytesHealth: WatermarkHealth = healthy();
  private assetWriteHealth: AssetWriteHealth = healthy();
  private diskHealth: DiskHealth = healthy();
  private intervalHandle: unknown;
  private intakeWriteHealth: IntakeWriteHealth = healthy();
  private nextAssetWriteFailureIdentity = 0;
  private nextIntakeWriteFailureIdentity = 0;
  private operationalSnapshotHealth: OperationalSnapshotHealth = healthy();
  private queueHealth: WatermarkHealth = healthy();
  private reconciliationInFlight: Promise<CaptureAdmissionSnapshot> | undefined;
  private retryHealth: WatermarkHealth = healthy();
  private status: CaptureAdmissionSnapshot = freezeSnapshot([]);
  private monitorEpoch = 0;
  private acceptingSamples = true;

  constructor(private readonly options: CaptureAdmissionControllerOptions) {}

  getStatus(): CaptureAdmissionSnapshot {
    return this.status;
  }

  reconcile(): Promise<CaptureAdmissionSnapshot> {
    if (!this.acceptingSamples) {
      return Promise.resolve(this.status);
    }

    if (this.reconciliationInFlight) {
      return this.reconciliationInFlight;
    }

    const epoch = this.monitorEpoch;
    const reconciliation = this.reconcileNow(epoch);
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

  async reportStorageFailure(): Promise<CaptureAdmissionSnapshot> {
    if (!this.acceptingSamples) {
      return this.status;
    }
    this.intakeWriteHealth = {
      state: 'failed',
      failureIdentity: ++this.nextIntakeWriteFailureIdentity,
      healthySamples: 0,
      verification: 'required',
    };
    await this.publishStatus(this.monitorEpoch);
    return this.getStatus();
  }

  async reportStorageWriteFailure(): Promise<CaptureAdmissionSnapshot> {
    if (!this.acceptingSamples) {
      return this.status;
    }
    this.assetWriteHealth = {
      state: 'failed',
      failureIdentity: ++this.nextAssetWriteFailureIdentity,
      verification: 'required',
    };
    await this.publishStatus(this.monitorEpoch);
    return this.getStatus();
  }

  private async reconcileNow(epoch: number): Promise<CaptureAdmissionSnapshot> {
    await Promise.all([this.reconcileQueueSignals(epoch), this.reconcileStorageSignals(epoch)]);
    await this.publishStatus(epoch);
    return this.getStatus();
  }

  async start(): Promise<void> {
    if (!this.acceptingSamples) {
      this.acceptingSamples = true;
      this.monitorEpoch += 1;
    }
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
    if (this.intervalHandle !== undefined) {
      const clearIntervalFn =
        this.options.clearIntervalFn ??
        ((handle: unknown) => clearInterval(handle as NodeJS.Timeout));
      clearIntervalFn(this.intervalHandle);
      this.intervalHandle = undefined;
    }

    if (!this.acceptingSamples) {
      return;
    }
    this.acceptingSamples = false;
    this.monitorEpoch += 1;
    this.reconciliationInFlight = undefined;
  }

  private async reconcileQueueSignals(epoch: number): Promise<void> {
    const intakeFailureIdentity = intakeFailureIdentityOf(this.intakeWriteHealth);
    try {
      const snapshot = await this.options.store.getBackpressureSnapshot();
      const decision = evaluateOperationalStoreBackpressure(snapshot, this.options.backpressure);
      if (!this.isCurrent(epoch)) return;
      this.operationalSnapshotHealth = healthy();
      this.intakeWriteHealth = recordHealthyOperationalSnapshot(
        this.intakeWriteHealth,
        intakeFailureIdentity,
      );
      this.queueHealth = updateUpperWaterMark(
        this.queueHealth,
        decision.reasons.includes('max_queued_jobs_reached'),
        snapshot.queuedJobs <= this.options.backpressure.resumeQueuedJobs,
      );
      this.retryHealth = updateUpperWaterMark(
        this.retryHealth,
        decision.reasons.includes('max_retrying_jobs_reached'),
        snapshot.retryingJobs <= this.options.backpressure.resumeRetryingJobs,
      );
      this.assetBytesHealth = updateUpperWaterMark(
        this.assetBytesHealth,
        decision.reasons.includes('max_asset_bytes_reached'),
        snapshot.assetBytes <= this.options.backpressure.resumeAssetBytes,
      );
    } catch {
      if (!this.isCurrent(epoch)) return;
      this.operationalSnapshotHealth = { state: 'unavailable' };
      this.intakeWriteHealth = resetHealthyOperationalSamples(this.intakeWriteHealth);
    }
  }

  private async reconcileStorageSignals(epoch: number): Promise<void> {
    if (!this.options.storage) {
      return;
    }

    const assetWriteFailureIdentity = assetWriteFailureIdentityOf(this.assetWriteHealth);
    const intakeFailureIdentity = intakeFailureIdentityOf(this.intakeWriteHealth);
    try {
      const snapshot = await this.options.storage.probe();
      if (!this.isCurrent(epoch)) return;
      this.diskHealth = updateLowerWaterMark(
        this.diskHealth,
        snapshot.availableBytes <= this.options.storage.minAvailableBytes,
        snapshot.availableBytes >= this.options.storage.resumeAvailableBytes,
      );
      if (!snapshot.writable) {
        if (this.assetWriteHealth.state === 'healthy') {
          this.assetWriteHealth = {
            state: 'failed',
            failureIdentity: ++this.nextAssetWriteFailureIdentity,
            verification: 'required',
          };
        }
      } else if (snapshot.availableBytes >= this.options.storage.resumeAvailableBytes) {
        if (assetWriteFailureIdentity !== undefined) {
          try {
            await this.options.storage.verifyWrite();
            if (
              this.isCurrent(epoch) &&
              assetWriteFailureIdentityOf(this.assetWriteHealth) === assetWriteFailureIdentity
            ) {
              this.assetWriteHealth = healthy();
            }
          } catch {
            // Keep the asset write-failure latch closed until a later verification succeeds.
          }
        }
        const intakeWriteHealth = this.intakeWriteHealth;
        if (
          intakeFailureIdentity !== undefined &&
          intakeWriteHealth.state === 'failed' &&
          intakeWriteHealth.failureIdentity === intakeFailureIdentity &&
          intakeWriteHealth.verification === 'required'
        ) {
          try {
            await this.options.store.verifyOperationalWrite();
            if (
              this.isCurrent(epoch) &&
              this.intakeWriteHealth.state === 'failed' &&
              this.intakeWriteHealth.failureIdentity === intakeFailureIdentity
            ) {
              this.intakeWriteHealth = {
                ...this.intakeWriteHealth,
                verification: 'confirmed',
              };
            }
          } catch {
            // Keep the intake storage-failure latch closed until a later verification succeeds.
          }
        }
      }
    } catch {
      if (!this.isCurrent(epoch)) return;
      this.diskHealth = { state: 'unavailable' };
    }
  }

  private isCurrent(epoch: number): boolean {
    return this.acceptingSamples && this.monitorEpoch === epoch;
  }

  private async publishStatus(epoch: number): Promise<void> {
    if (!this.isCurrent(epoch)) {
      return;
    }
    const reasons: CaptureAdmissionReason[] = [
      ...(this.queueHealth.state === 'blocked' ? (['max_queued_jobs_reached'] as const) : []),
      ...(this.retryHealth.state === 'blocked' ? (['max_retrying_jobs_reached'] as const) : []),
      ...(this.assetBytesHealth.state === 'blocked' ? (['max_asset_bytes_reached'] as const) : []),
      ...(this.diskHealth.state === 'low_capacity'
        ? (['min_available_storage_reached'] as const)
        : []),
      ...(this.assetWriteHealth.state === 'failed' ? (['asset_write_failed'] as const) : []),
      ...(this.operationalSnapshotHealth.state === 'unavailable'
        ? (['queue_state_unavailable'] as const)
        : []),
      ...(this.diskHealth.state === 'unavailable' || this.intakeWriteHealth.state === 'failed'
        ? (['storage_state_unavailable'] as const)
        : []),
    ];
    const next = freezeSnapshot(reasons);
    if (sameStatus(this.status, next)) {
      return;
    }
    this.status = next;
    await this.options.onStatusChange?.(next);
  }
}

function sameStatus(left: CaptureAdmissionSnapshot, right: CaptureAdmissionSnapshot): boolean {
  return left.reasons.join('\u0000') === right.reasons.join('\u0000');
}

function freezeSnapshot(reasons: readonly CaptureAdmissionReason[]): CaptureAdmissionSnapshot {
  return Object.freeze({ reasons: Object.freeze([...reasons]) });
}

function healthy(): HealthyHealth {
  return { state: 'healthy' };
}

function updateUpperWaterMark(
  health: WatermarkHealth,
  highReached: boolean,
  lowReached: boolean,
): WatermarkHealth {
  if (health.state === 'blocked') {
    return lowReached ? healthy() : health;
  }
  return highReached ? { state: 'blocked' } : health;
}

function updateLowerWaterMark(
  health: DiskHealth,
  lowReached: boolean,
  highReached: boolean,
): DiskHealth {
  if (lowReached) {
    return { state: 'low_capacity' };
  }
  if (health.state === 'low_capacity' && !highReached) {
    return health;
  }
  return healthy();
}

function assetWriteFailureIdentityOf(health: AssetWriteHealth): number | undefined {
  return health.state === 'failed' ? health.failureIdentity : undefined;
}

function intakeFailureIdentityOf(health: IntakeWriteHealth): number | undefined {
  return health.state === 'failed' ? health.failureIdentity : undefined;
}

function recordHealthyOperationalSnapshot(
  health: IntakeWriteHealth,
  sampledFailureIdentity: number | undefined,
): IntakeWriteHealth {
  if (health.state !== 'failed' || health.failureIdentity !== sampledFailureIdentity) {
    return health;
  }

  const next = {
    ...health,
    healthySamples: health.healthySamples + 1,
  };
  if (next.healthySamples >= INTAKE_RECOVERY_SAMPLES && next.verification === 'confirmed') {
    return healthy();
  }
  return next;
}

function resetHealthyOperationalSamples(health: IntakeWriteHealth): IntakeWriteHealth {
  if (health.state === 'healthy' || health.healthySamples === 0) {
    return health;
  }
  return { ...health, healthySamples: 0 };
}
