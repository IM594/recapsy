import { type CaptureResultInput, createSafeCaptureResultPayload } from './capture-result';
import {
  HELPER_PROTOCOL_VERSION,
  type HelperEnvelope,
  type HelperToMainType,
} from './protocol/types';
import type { HelperLifecycle } from './types';

export type MockHelperState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'paused'
  | 'shutdown'
  | 'exiting'
  | 'crashed';

export type MockHelperExitReason =
  | 'shutdown_requested'
  | 'quit_requested'
  | 'process_crashed'
  | 'unknown';

export type MockHelperSnapshot = {
  state: MockHelperState;
  terminal: boolean;
  heartbeatCount: number;
  emittedCaptureCount: number;
  pendingCaptureCount: number;
  acknowledgedCaptureCount: number;
  lastExitReason: MockHelperExitReason | null;
};

export type MockHelperController = HelperLifecycle & {
  getSnapshot(): MockHelperSnapshot;
  simulateHeartbeat(): MockHelperEmitResult<HelperEnvelope<'helper.heartbeat'>>;
  simulateCapture(
    input: CaptureResultInput,
  ): MockHelperEmitResult<HelperEnvelope<'capture.result'>>;
  ackCapture(captureId: string): MockHelperCommandResult;
  nackCapture(captureId: string, reason: string): MockHelperCommandResult;
  simulateExiting(
    reason: MockHelperExitReason,
  ): MockHelperEmitResult<HelperEnvelope<'helper.exiting'>>;
  simulateCrash(reason: MockHelperExitReason): void;
  drainMessages(): HelperEnvelope[];
};

export type MockHelperEmitResult<TEnvelope extends HelperEnvelope> =
  | {
      ok: true;
      envelope: TEnvelope;
    }
  | {
      ok: false;
      error: MockHelperError;
    };

export type MockHelperCommandResult =
  | {
      ok: true;
    }
  | MockHelperFailure;

export type MockHelperFailure = {
  ok: false;
  error: MockHelperError;
};

export type MockHelperError = {
  code: 'capture_paused' | 'capture_not_found' | 'helper_not_ready' | 'helper_terminal';
  message: string;
};

export function createMockHelperController(): MockHelperController {
  return new InMemoryMockHelperController();
}

class InMemoryMockHelperController implements MockHelperController {
  private acknowledgedCaptureCount = 0;
  private heartbeatCount = 0;
  private messageSequence = 0;
  private readonly messages: HelperEnvelope[] = [];
  private readonly pendingCaptures = new Map<string, HelperEnvelope<'capture.result'>>();
  private state: MockHelperState = 'idle';
  private lastExitReason: MockHelperExitReason | null = null;

  async start(): Promise<void> {
    if (this.isTerminal()) {
      return;
    }

    this.state = 'starting';
    this.messages.push(
      this.createEnvelope('helper.hello', {
        helperVersion: 'mock-helper/1.0.0',
        pid: null,
        capabilities: {
          capture: true,
          permissions: true,
          mock: true,
        },
      }),
    );
    this.messages.push(
      this.createEnvelope('permission.status', {
        screenCapture: 'granted',
        accessibility: 'not_determined',
        observedAt: new Date(0).toISOString(),
      }),
    );
    this.state = 'ready';
  }

  async pauseCapture(): Promise<void> {
    if (this.state === 'ready') {
      this.state = 'paused';
      this.messages.push(
        this.createEnvelope('helper.status', {
          status: 'paused',
          reason: 'capture_paused',
        }),
      );
    }
  }

  async resumeCapture(): Promise<void> {
    if (this.state === 'paused') {
      this.state = 'ready';
      this.messages.push(
        this.createEnvelope('helper.status', {
          status: 'ready',
          reason: 'capture_resumed',
        }),
      );
    }
  }

  async shutdown(): Promise<void> {
    if (this.state === 'shutdown') {
      return;
    }

    this.pendingCaptures.clear();
    this.state = 'shutdown';
    this.lastExitReason = 'shutdown_requested';
    this.messages.push(
      this.createEnvelope('helper.exiting', {
        reason: 'shutdown_requested',
        code: 0,
      }),
    );
  }

  getSnapshot(): MockHelperSnapshot {
    return {
      state: this.state,
      terminal: this.isTerminal(),
      heartbeatCount: this.heartbeatCount,
      emittedCaptureCount: this.acknowledgedCaptureCount + this.pendingCaptures.size,
      pendingCaptureCount: this.pendingCaptures.size,
      acknowledgedCaptureCount: this.acknowledgedCaptureCount,
      lastExitReason: this.lastExitReason,
    };
  }

  simulateHeartbeat(): MockHelperEmitResult<HelperEnvelope<'helper.heartbeat'>> {
    const guard = this.ensureCanEmit();
    if (!guard.ok) {
      return guard;
    }

    this.heartbeatCount += 1;
    const envelope = this.createEnvelope('helper.heartbeat', {
      sequence: this.heartbeatCount,
      status: this.state === 'paused' ? 'paused' : 'ready',
    });
    this.messages.push(envelope);

    return {
      ok: true,
      envelope,
    };
  }

  simulateCapture(
    input: CaptureResultInput,
  ): MockHelperEmitResult<HelperEnvelope<'capture.result'>> {
    const guard = this.ensureCanEmit();
    if (!guard.ok) {
      return guard;
    }

    if (this.state === 'paused') {
      return commandError(
        'capture_paused',
        'Mock helper is paused and will not produce new captures.',
      );
    }

    const envelope = this.createEnvelope('capture.result', createSafeCaptureResultPayload(input));
    this.pendingCaptures.set(input.captureId, envelope);
    this.messages.push(envelope);

    return {
      ok: true,
      envelope,
    };
  }

  ackCapture(captureId: string): MockHelperCommandResult {
    if (!this.pendingCaptures.delete(captureId)) {
      return commandError('capture_not_found', 'Capture is not pending acknowledgement.');
    }

    this.acknowledgedCaptureCount += 1;

    return {
      ok: true,
    };
  }

  nackCapture(captureId: string, _reason: string): MockHelperCommandResult {
    if (!this.pendingCaptures.delete(captureId)) {
      return commandError('capture_not_found', 'Capture is not pending acknowledgement.');
    }

    return {
      ok: true,
    };
  }

  simulateExiting(
    reason: MockHelperExitReason,
  ): MockHelperEmitResult<HelperEnvelope<'helper.exiting'>> {
    if (this.isTerminal()) {
      return commandError(
        'helper_terminal',
        'Mock helper is terminal and cannot emit new messages.',
      );
    }

    this.pendingCaptures.clear();
    this.state = 'exiting';
    this.lastExitReason = reason;
    const envelope = this.createEnvelope('helper.exiting', {
      reason,
      code: reason === 'process_crashed' ? 1 : 0,
    });
    this.messages.push(envelope);

    return {
      ok: true,
      envelope,
    };
  }

  simulateCrash(reason: MockHelperExitReason): void {
    this.pendingCaptures.clear();
    this.state = 'crashed';
    this.lastExitReason = reason;
  }

  drainMessages(): HelperEnvelope[] {
    return this.messages.splice(0);
  }

  private ensureCanEmit(): MockHelperCommandResult {
    if (this.isTerminal()) {
      return commandError(
        'helper_terminal',
        'Mock helper is terminal and cannot emit new messages.',
      );
    }

    if (this.state !== 'ready' && this.state !== 'paused') {
      return commandError('helper_not_ready', 'Mock helper is not ready.');
    }

    return {
      ok: true,
    };
  }

  private isTerminal(): boolean {
    return this.state === 'shutdown' || this.state === 'exiting' || this.state === 'crashed';
  }

  private createEnvelope<TType extends HelperToMainType>(
    type: TType,
    payload: HelperEnvelope<TType>['payload'],
  ): HelperEnvelope<TType> {
    this.messageSequence += 1;

    return {
      protocolVersion: HELPER_PROTOCOL_VERSION,
      messageId: `mock_${this.messageSequence}`,
      correlationId: null,
      sentAt: new Date(this.messageSequence).toISOString(),
      type,
      payload,
    } as HelperEnvelope<TType>;
  }
}

function commandError(code: MockHelperError['code'], message: string): MockHelperFailure {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}
