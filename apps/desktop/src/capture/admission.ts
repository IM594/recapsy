import {
  type BackpressureConfig,
  type BackpressureReason,
  type OperationalStoreSnapshot,
  evaluateOperationalStoreBackpressure,
} from '../storage/index';

export type CaptureAdmissionStore = {
  getBackpressureSnapshot(workspaceId: string): Promise<OperationalStoreSnapshot>;
};

export type CaptureAdmissionLifecycle = {
  setAutomaticPause(active: boolean): Promise<void>;
  setStoragePause(active: boolean): Promise<void>;
};

export type CaptureAdmissionStatus = {
  active: boolean;
  reasons: readonly (BackpressureReason | 'queue_state_unavailable')[];
};

export type CaptureAdmissionController = {
  getStatus(): CaptureAdmissionStatus;
  reconcile(): Promise<CaptureAdmissionStatus>;
  start(): Promise<void>;
  stop(): void;
};

export type CaptureAdmissionControllerOptions = {
  backpressure: BackpressureConfig;
  clearIntervalFn?: (handle: unknown) => void;
  intervalMs?: number;
  lifecycle: CaptureAdmissionLifecycle;
  setIntervalFn?: (callback: () => void, delayMs: number) => unknown;
  store: CaptureAdmissionStore;
  workspaceId: string;
};

const DEFAULT_RECONCILIATION_INTERVAL_MS = 1000;

/**
 * Owns automatic capture admission. The controller has hysteresis: reaching a
 * high water mark pauses new frames, and only clearing every low water mark
 * resumes them. Manual pause ownership stays in the lifecycle.
 */
export function createCaptureAdmissionController(
  options: CaptureAdmissionControllerOptions,
): CaptureAdmissionController {
  return new StoreBackedCaptureAdmissionController(options);
}

class StoreBackedCaptureAdmissionController implements CaptureAdmissionController {
  private active = false;
  private intervalHandle: unknown;
  private reasons: CaptureAdmissionStatus['reasons'] = [];

  constructor(private readonly options: CaptureAdmissionControllerOptions) {}

  getStatus(): CaptureAdmissionStatus {
    return { active: this.active, reasons: [...this.reasons] } as CaptureAdmissionStatus;
  }

  async reconcile(): Promise<CaptureAdmissionStatus> {
    try {
      const snapshot = await this.options.store.getBackpressureSnapshot(this.options.workspaceId);
      const decision = evaluateOperationalStoreBackpressure(snapshot, this.options.backpressure);
      if (decision.action === 'pause') {
        await this.setPauseCauses(decision.reasons);
      } else {
        await this.clearRecoveredPauseCauses(snapshot);
      }
    } catch {
      await this.options.lifecycle.setAutomaticPause(true);
      await this.options.lifecycle.setStoragePause(false);
      this.active = true;
      this.reasons = ['queue_state_unavailable'];
    }

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

  private async setPauseCauses(reasons: CaptureAdmissionStatus['reasons']): Promise<void> {
    if (this.active && sameReasons(this.reasons, reasons)) {
      return;
    }
    const queueBlocked = reasons.includes('max_queued_jobs_reached');
    const storageBlocked = reasons.includes('max_asset_bytes_reached');
    if (this.reasons.includes('max_queued_jobs_reached') !== queueBlocked) {
      await this.options.lifecycle.setAutomaticPause(queueBlocked);
    }
    if (this.reasons.includes('max_asset_bytes_reached') !== storageBlocked) {
      await this.options.lifecycle.setStoragePause(storageBlocked);
    }
    this.active = queueBlocked || storageBlocked;
    this.reasons = [...reasons] as CaptureAdmissionStatus['reasons'];
  }

  private async clearRecoveredPauseCauses(snapshot: OperationalStoreSnapshot): Promise<void> {
    const queueRecovered = snapshot.queuedJobs <= this.options.backpressure.resumeQueuedJobs;
    const storageRecovered = snapshot.assetBytes <= this.options.backpressure.resumeAssetBytes;
    const reasons: CaptureAdmissionStatus['reasons'] = [
      ...(!queueRecovered ? (['max_queued_jobs_reached'] as const) : []),
      ...(!storageRecovered ? (['max_asset_bytes_reached'] as const) : []),
    ];
    if (this.active === reasons.length > 0 && sameReasons(this.reasons, reasons)) {
      return;
    }
    const queueBlocked = !queueRecovered;
    const storageBlocked = !storageRecovered;
    if (this.reasons.includes('max_queued_jobs_reached') !== queueBlocked) {
      await this.options.lifecycle.setAutomaticPause(queueBlocked);
    }
    if (this.reasons.includes('max_asset_bytes_reached') !== storageBlocked) {
      await this.options.lifecycle.setStoragePause(storageBlocked);
    }
    this.active = reasons.length > 0;
    this.reasons = reasons;
  }
}

function sameReasons(
  left: CaptureAdmissionStatus['reasons'],
  right: CaptureAdmissionStatus['reasons'],
): boolean {
  return left.length === right.length && left.every((reason, index) => reason === right[index]);
}
