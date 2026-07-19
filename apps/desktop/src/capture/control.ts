import type { CaptureHelperStatus, CaptureHelperTermination } from '../helper/index';
import type { HelperPermissionState, SafeOperationalError } from '../storage/index';
import type { CaptureAdmissionSnapshot } from './admission';
import type { CapturePolicyController, CapturePolicySnapshot } from './policy';

export type CaptureStartupRecovery = {
  recover(): Promise<void>;
};

export type CaptureAssetReconciliation = {
  reconcile(): Promise<void>;
};

export type CaptureControlStatus = 'starting' | 'running' | 'paused' | 'stopping' | 'stopped';
export type CapturePauseCause = 'user' | 'backpressure' | 'storage' | 'policy' | 'permission';

export type CapturePermissionSnapshot = {
  accessibility: HelperPermissionState;
  screenRecording: HelperPermissionState;
};

export type CaptureHelperExitReason =
  | 'shutdown_requested'
  | 'quit_requested'
  | 'process_crashed'
  | 'unknown';

export type CaptureHelperObservation =
  | {
      observedAt: string;
      permissions: CapturePermissionSnapshot;
      type: 'permission';
    }
  | {
      code: string;
      observedAt: string;
      type: 'capture_error';
    }
  | { observedAt: string; type: 'capture_result' }
  | { observedAt: string; reason: CaptureHelperExitReason; type: 'helper_exit' }
  | { observedAt: string; type: 'heartbeat' }
  | { observedAt: string; type: 'protocol_error' };

export type CaptureControlSnapshot = {
  admission: CaptureAdmissionSnapshot;
  captureFailureCount: number;
  permissions: CapturePermissionSnapshot;
  lastHeartbeatAt?: string;
  lastSafeError?: SafeOperationalError;
  status: CaptureControlStatus;
  menuBarActive: boolean;
  pauseReasons?: CapturePauseCause[];
  captureHelper?: CaptureHelperStatus;
};

export type CaptureControl = {
  getSnapshot(): CaptureControlSnapshot;
  start(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  updateAdmission(status: CaptureAdmissionSnapshot): Promise<void>;
  handleLastWindowClosed(): Promise<void>;
  requestQuit(): Promise<void>;
  stop(): Promise<void>;
  handleHelperTermination(event: CaptureHelperTermination): Promise<void>;
  recordHelperObservation(observation: CaptureHelperObservation): Promise<void>;
};

/** The control plane owns the narrow command port it consumes. */
export type CaptureControlHelperPort = {
  start(): Promise<void>;
  beginCapture(reason: 'runtime_started' | 'user_resumed'): Promise<void>;
  pauseCapture(): Promise<void>;
  resumeCapture(): Promise<void>;
  stop(): Promise<void>;
};

export type CaptureControlOptions = {
  helper: CaptureControlHelperPort;
  policy: CapturePolicyController;
  startupRecovery?: CaptureStartupRecovery;
  assetReconciliation?: CaptureAssetReconciliation;
  initialPermissions?: CapturePermissionSnapshot;
};

export function createCaptureControl(options: CaptureControlOptions): CaptureControl {
  return new CaptureControlActor(options);
}

type DesiredCaptureState = 'running' | 'stopped';
type ControlOperation = object;
type ControlState =
  | { kind: 'stopped' }
  | { kind: 'recovering'; operation: ControlOperation }
  | { kind: 'reconciling'; operation: ControlOperation }
  | { kind: 'startingHelper'; operation: ControlOperation }
  | { kind: 'activatingPolicy'; operation: ControlOperation }
  | { kind: 'readyPaused'; operation: ControlOperation }
  | { kind: 'running'; operation: ControlOperation }
  | { kind: 'paused'; operation: ControlOperation }
  | { kind: 'stopping'; operation: ControlOperation };

type CaptureHelperMetadata = Omit<CaptureHelperStatus, 'state'>;
type StopEffect = {
  operation: ControlOperation;
  promise: Promise<void>;
};

class CaptureControlActor implements CaptureControl {
  private captureHelper: CaptureHelperMetadata | undefined;
  private captureFailureCount = 0;
  private admission: CaptureAdmissionSnapshot = Object.freeze({ reasons: [] });
  private permissions: CapturePermissionSnapshot;
  private lastHeartbeatAt: string | undefined;
  private desiredState: DesiredCaptureState = 'stopped';
  private menuBarActive = false;
  private state: ControlState = { kind: 'stopped' };
  private stopEffect: StopEffect | undefined;
  private transitionDrain: Promise<void> = Promise.resolve();
  private userPaused = false;

  constructor(private readonly options: CaptureControlOptions) {
    this.permissions = {
      accessibility: options.initialPermissions?.accessibility ?? 'unknown',
      screenRecording: options.initialPermissions?.screenRecording ?? 'unknown',
    };
    options.policy.subscribe((snapshot) => this.receivePolicySnapshot(snapshot));
  }

  getSnapshot(): CaptureControlSnapshot {
    const policy = this.options.policy.getSnapshot();
    const pauseReasons = deriveCaptureGate(
      this.admission,
      this.permissions,
      policy,
      this.userPaused,
    );
    const policyConfiguration =
      policy.status === 'active' || policy.status === 'inactive' ? policy.configuration : undefined;
    const lastSafeError =
      this.captureHelper?.lastSafeError ??
      (policy.status === 'blocked' ? policyUnavailableError() : undefined);
    const captureHelper =
      this.captureHelper || policyConfiguration || policy.status === 'blocked'
        ? {
            ...this.captureHelper,
            ...(policyConfiguration
              ? {
                  policyHash: policyConfiguration.policy.policyHash,
                  policyVersion: policyConfiguration.policy.version,
                }
              : {}),
            state: helperState(this.state, this.captureHelper ?? {}),
            ...(lastSafeError ? { lastSafeError } : {}),
          }
        : undefined;

    return {
      admission: { reasons: [...this.admission.reasons] },
      captureFailureCount: this.captureFailureCount,
      ...(captureHelper ? { captureHelper } : {}),
      ...(this.lastHeartbeatAt ? { lastHeartbeatAt: this.lastHeartbeatAt } : {}),
      ...(lastSafeError ? { lastSafeError: { ...lastSafeError } } : {}),
      menuBarActive: this.menuBarActive,
      permissions: { ...this.permissions },
      ...(pauseReasons.length > 0 ? { pauseReasons } : {}),
      status: visibleStatus(this.state),
    };
  }

  recordHelperObservation(observation: CaptureHelperObservation): Promise<void> {
    return this.enqueue(() => {
      if (observation.type === 'heartbeat') {
        this.lastHeartbeatAt = observation.observedAt;
      }

      switch (observation.type) {
        case 'permission':
          this.permissions = { ...observation.permissions };
          return;
        case 'capture_error':
          if (observation.code === 'capture_failed') this.captureFailureCount += 1;
          this.captureHelper = {
            ...policyStatus(this.captureHelper),
            lastSafeError: safeCaptureError(observation.code),
          };
          return;
        case 'capture_result':
          this.captureFailureCount = 0;
          this.captureHelper = clearSafeError(this.captureHelper);
          return;
        case 'helper_exit':
          if (
            observation.reason === 'shutdown_requested' ||
            observation.reason === 'quit_requested'
          ) {
            return;
          }
          this.captureHelper = {
            ...policyStatus(this.captureHelper),
            lastSafeError: safeOperationalError(
              'helper_unexpected_exit',
              'Capture helper stopped unexpectedly.',
              true,
            ),
          };
          return;
        case 'heartbeat':
          return;
        case 'protocol_error':
          this.captureHelper = {
            ...policyStatus(this.captureHelper),
            lastSafeError: safeOperationalError(
              'unknown',
              'Capture event could not be accepted.',
              true,
            ),
          };
          return;
      }
    });
  }

  start(): Promise<void> {
    return this.enqueue(() => {
      this.desiredState = 'running';
    });
  }

  pause(): Promise<void> {
    return this.enqueue(() => {
      this.userPaused = true;
    });
  }

  resume(): Promise<void> {
    return this.enqueue(() => {
      this.userPaused = false;
    });
  }

  updateAdmission(status: CaptureAdmissionSnapshot): Promise<void> {
    return this.enqueue(() => {
      this.admission = { reasons: [...status.reasons] };
    });
  }

  async handleLastWindowClosed(): Promise<void> {
    await this.enqueue(() => {
      const status = visibleStatus(this.state);
      if (status === 'running' || status === 'paused') {
        this.menuBarActive = true;
      }
    });
  }

  requestQuit(): Promise<void> {
    return this.stop();
  }

  stop(): Promise<void> {
    this.desiredState = 'stopped';
    this.options.policy.deactivate();
    this.menuBarActive = false;

    switch (this.state.kind) {
      case 'stopped':
      case 'stopping':
        return this.stopEffect?.promise ?? Promise.resolve();
      case 'recovering':
      case 'reconciling':
        this.state = { kind: 'stopped' };
        return Promise.resolve();
      case 'startingHelper':
        // The active transition owns helper.start() and stops it once startup
        // completes. Quitting must wait for that shutdown rather than exiting
        // while the helper process is still being spawned.
        return this.transitionDrain;
      case 'activatingPolicy':
      case 'readyPaused':
      case 'running':
      case 'paused':
        return this.requestHelperStop(this.state.operation);
    }
  }

  handleHelperTermination(_event: CaptureHelperTermination): Promise<void> {
    return this.enqueue(() => {
      this.desiredState = 'stopped';
      this.options.policy.deactivate();
      this.menuBarActive = false;
      this.state = { kind: 'stopped' };
      this.captureHelper = {
        ...policyStatus(this.captureHelper),
        lastSafeError: safeOperationalError(
          'helper_unexpected_exit',
          'Capture helper exited unexpectedly.',
          true,
        ),
      };
      this.captureFailureCount = 0;
    });
  }

  private enqueue(update: () => void): Promise<void> {
    update();
    const transition = this.transitionDrain.then(() => this.reconcile());
    this.transitionDrain = transition.catch(() => undefined);
    return transition;
  }

  private receivePolicySnapshot(snapshot: CapturePolicySnapshot): Promise<void> {
    return this.enqueue(() => {
      if (snapshot.status === 'blocked') {
        this.captureHelper = {
          ...policyStatus(this.captureHelper),
          lastSafeError: policyUnavailableError(),
        };
        return;
      }
      if (snapshot.status === 'active') {
        const safeError = this.captureHelper?.lastSafeError;
        this.captureHelper = {
          ...(safeError?.code !== 'policy_unavailable' && safeError
            ? { lastSafeError: safeError }
            : {}),
        };
      }
    });
  }

  private async reconcile(): Promise<void> {
    for (;;) {
      const state = this.state;

      if (this.desiredState === 'stopped') {
        switch (state.kind) {
          case 'stopped':
            return;
          case 'recovering':
          case 'reconciling':
            this.state = { kind: 'stopped' };
            return;
          case 'startingHelper':
            return;
          case 'stopping':
            await this.requestHelperStop(state.operation);
            return;
          case 'activatingPolicy':
          case 'readyPaused':
          case 'running':
          case 'paused':
            await this.requestHelperStop(state.operation);
            return;
        }
      }

      switch (state.kind) {
        case 'stopped':
          await this.startHelper();
          continue;
        case 'stopping':
          await this.requestHelperStop(state.operation);
          continue;
        case 'readyPaused':
          if (this.captureGateIsOpen()) {
            await this.beginCapture(state.operation);
            continue;
          }
          return;
        case 'running':
          if (!this.captureGateIsOpen()) {
            await this.pauseCapture(state.operation);
            continue;
          }
          return;
        case 'paused':
          if (this.captureGateIsOpen()) {
            await this.resumeCapture(state.operation);
            continue;
          }
          return;
        case 'recovering':
        case 'reconciling':
        case 'startingHelper':
        case 'activatingPolicy':
          return;
      }
    }
  }

  private async startHelper(): Promise<void> {
    const operation = {};
    this.menuBarActive = false;
    this.state = { kind: 'recovering', operation };

    try {
      await this.options.startupRecovery?.recover();
    } catch (error) {
      if (this.holdsOperation(operation)) this.state = { kind: 'stopped' };
      throw error;
    }
    if (!this.holdsOperation(operation)) return;
    if (this.desiredState !== 'running') {
      this.state = { kind: 'stopped' };
      return;
    }

    this.state = { kind: 'reconciling', operation };
    try {
      await this.options.assetReconciliation?.reconcile();
    } catch (error) {
      if (this.holdsOperation(operation)) this.state = { kind: 'stopped' };
      throw error;
    }
    if (!this.holdsOperation(operation)) return;
    if (this.desiredState !== 'running') {
      this.state = { kind: 'stopped' };
      return;
    }

    this.state = { kind: 'startingHelper', operation };
    try {
      await this.options.helper.start();
    } catch (error) {
      if (!this.holdsOperation(operation)) return;
      if (this.desiredState !== 'running') {
        this.state = { kind: 'stopped' };
        return;
      }
      this.captureHelper = {
        lastSafeError: {
          code: 'helper_start_failed',
          message: 'Capture helper failed to start.',
          retryable: true,
        },
      };
      this.state = { kind: 'stopped' };
      throw error;
    }
    if (!this.holdsOperation(operation)) return;
    if (this.desiredState !== 'running') {
      await this.requestHelperStop(operation);
      return;
    }

    this.state = { kind: 'activatingPolicy', operation };
    try {
      await this.options.policy.activate();
    } catch {
      if (this.holdsOperation(operation) && this.desiredState === 'running') {
        this.state = { kind: 'readyPaused', operation };
      }
      return;
    }
    if (!this.holdsOperation(operation)) return;
    if (this.desiredState !== 'running') {
      await this.requestHelperStop(operation);
      return;
    }

    this.state = { kind: 'readyPaused', operation };
    if (this.captureGateIsOpen()) {
      await this.beginCapture(operation);
    }
  }

  private async beginCapture(operation: ControlOperation): Promise<void> {
    try {
      await this.options.helper.beginCapture('runtime_started');
    } catch (error) {
      if (!this.holdsOperation(operation)) return;
      this.captureHelper = {
        ...policyStatus(this.captureHelper),
        lastSafeError: safeCaptureError('helper_unavailable'),
      };
      throw error;
    }
    if (!this.holdsOperation(operation)) return;
    this.captureHelper = clearSafeError(this.captureHelper);
    this.state = { kind: 'running', operation };
  }

  private async pauseCapture(operation: ControlOperation): Promise<void> {
    try {
      await this.options.helper.pauseCapture();
    } catch (error) {
      if (!this.holdsOperation(operation)) return;
      this.captureHelper = {
        ...policyStatus(this.captureHelper),
        lastSafeError: safeCaptureError('helper_unavailable'),
      };
      try {
        await this.requestHelperStop(operation);
      } catch {
        // The pause error remains the command failure visible to the caller.
      }
      throw error;
    }
    if (this.holdsOperation(operation)) this.state = { kind: 'paused', operation };
  }

  private async resumeCapture(operation: ControlOperation): Promise<void> {
    try {
      await this.options.helper.resumeCapture();
    } catch (error) {
      if (!this.holdsOperation(operation)) return;
      this.captureHelper = {
        ...policyStatus(this.captureHelper),
        lastSafeError: safeCaptureError('helper_unavailable'),
      };
      throw error;
    }
    if (this.holdsOperation(operation)) {
      this.captureHelper = clearSafeError(this.captureHelper);
      this.state = { kind: 'running', operation };
    }
  }

  private requestHelperStop(operation: ControlOperation): Promise<void> {
    if (!this.holdsOperation(operation)) return Promise.resolve();
    if (this.stopEffect?.operation === operation) return this.stopEffect.promise;

    this.state = { kind: 'stopping', operation };
    const promise = Promise.resolve()
      .then(() => this.options.helper.stop())
      .then(
        () => {
          if (this.isState('stopping', operation)) this.state = { kind: 'stopped' };
          if (this.stopEffect?.operation === operation) this.stopEffect = undefined;
        },
        (error: unknown) => {
          if (this.isState('stopping', operation)) {
            this.captureHelper = {
              ...policyStatus(this.captureHelper),
              lastSafeError: {
                code: 'helper_shutdown_failed',
                message: 'Capture helper failed to shut down.',
                retryable: true,
              },
            };
          }
          if (this.stopEffect?.operation === operation) this.stopEffect = undefined;
          throw error;
        },
      );
    this.stopEffect = { operation, promise };
    return promise;
  }

  private captureGateIsOpen(): boolean {
    return (
      deriveCaptureGate(
        this.admission,
        this.permissions,
        this.options.policy.getSnapshot(),
        this.userPaused,
      ).length === 0
    );
  }

  private holdsOperation(operation: ControlOperation): boolean {
    return 'operation' in this.state && this.state.operation === operation;
  }

  private isState(kind: ControlState['kind'], operation: ControlOperation): boolean {
    return this.state.kind === kind && this.holdsOperation(operation);
  }
}

function policyStatus(
  status: CaptureHelperMetadata | undefined,
): Pick<CaptureHelperStatus, 'policyHash' | 'policyVersion'> {
  return {
    ...(status?.policyHash ? { policyHash: status.policyHash } : {}),
    ...(status?.policyVersion ? { policyVersion: status.policyVersion } : {}),
  };
}

function clearSafeError(status: CaptureHelperMetadata | undefined): CaptureHelperMetadata {
  return policyStatus(status);
}

function helperState(
  state: ControlState,
  metadata: CaptureHelperMetadata,
): CaptureHelperStatus['state'] {
  if (metadata.lastSafeError?.code === 'helper_start_failed') return 'failed';
  if (metadata.lastSafeError?.code === 'helper_shutdown_failed') return 'failed';
  if (metadata.lastSafeError?.code === 'helper_unexpected_exit') return 'failed';

  switch (state.kind) {
    case 'recovering':
    case 'reconciling':
    case 'startingHelper':
    case 'activatingPolicy':
      return 'starting';
    case 'readyPaused':
    case 'paused':
      return 'paused';
    case 'running':
      return 'running';
    case 'stopping':
      return 'stopping';
    case 'stopped':
      return 'stopped';
  }
}

function deriveCaptureGate(
  admission: CaptureAdmissionSnapshot,
  permissions: CapturePermissionSnapshot,
  policy: CapturePolicySnapshot,
  userPaused: boolean,
): CapturePauseCause[] {
  const causes: CapturePauseCause[] = [];
  if (userPaused) causes.push('user');
  if (
    policy.status === 'blocked' ||
    (policy.status === 'active' && policy.configuration.policy.paused)
  ) {
    causes.push('policy');
  }
  if (permissions.screenRecording !== 'granted') causes.push('permission');
  if (
    admission.reasons.some((reason) =>
      ['min_available_storage_reached', 'asset_write_failed', 'storage_state_unavailable'].includes(
        reason,
      ),
    )
  ) {
    causes.push('storage');
  }
  if (
    admission.reasons.some((reason) =>
      [
        'max_queued_jobs_reached',
        'max_retrying_jobs_reached',
        'max_asset_bytes_reached',
        'queue_state_unavailable',
      ].includes(reason),
    )
  ) {
    causes.push('backpressure');
  }
  return causes;
}

function visibleStatus(state: ControlState): CaptureControlStatus {
  switch (state.kind) {
    case 'recovering':
    case 'reconciling':
    case 'startingHelper':
    case 'activatingPolicy':
      return 'starting';
    case 'readyPaused':
      return 'paused';
    case 'running':
    case 'paused':
    case 'stopping':
    case 'stopped':
      return state.kind;
  }
}

function safeCaptureError(code: string): SafeOperationalError {
  switch (code) {
    case 'asset_write_failed':
      return safeOperationalError(code, 'Capture asset could not be written.', true);
    case 'permission_missing':
    case 'permission_revoked':
      return safeOperationalError(code, 'Capture permission is not available.', false);
    case 'helper_unavailable':
      return safeOperationalError(code, 'Capture helper is unavailable.', true);
    case 'capture_failed':
      return safeOperationalError(code, 'Capture failed.', true);
    default:
      return safeOperationalError('unknown', 'Capture helper reported an error.', true);
  }
}

function policyUnavailableError(): SafeOperationalError {
  return safeOperationalError('policy_unavailable', 'Capture policy is unavailable.', true);
}

function safeOperationalError(
  code: string,
  message: string,
  retryable: boolean,
): SafeOperationalError {
  return { code, message, retryable };
}
