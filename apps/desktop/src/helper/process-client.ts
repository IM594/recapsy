import { spawn as nodeSpawn } from 'node:child_process';
import { HelperNdjsonLineParser, encodeHelperEnvelope } from './protocol/codec';
import {
  HELPER_PROTOCOL_VERSION,
  type HelperCaptureIdentity,
  type HelperCapturePolicy,
  type HelperEnvelope,
  type HelperProtocolError,
  type HelperProtocolResult,
  type HelperToMainEnvelope,
  type MainToHelperPayloadByType,
  type MainToHelperType,
} from './protocol/types';
import { validateHelperToMainEnvelope } from './protocol/validation';
import type {
  CaptureHelperClient,
  CaptureHelperCommandClient,
  CaptureHelperTransportObserver,
  HelperPermissionCommandOptions,
  HelperPermissionSnapshot,
} from './types';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3000;
const DEFAULT_STARTUP_TIMEOUT_MS = 5000;
const DEFAULT_POLICY_ACK_TIMEOUT_MS = 5000;
const DEFAULT_PERMISSION_REFRESH_TIMEOUT_MS = 2000;
const DEFAULT_SCREEN_RECORDING_REQUEST_TIMEOUT_MS = 60_000;
const FORCE_KILL_GRACE_MS = 1000;

export type HelperTransportErrorCode = 'helper_shutdown_failed' | 'helper_unavailable';

const TRANSPORT_ERROR_MESSAGES: Record<HelperTransportErrorCode, string> = {
  helper_shutdown_failed: 'Capture helper failed to shut down.',
  helper_unavailable: 'Capture helper is unavailable.',
};

export class HelperTransportError extends Error {
  readonly name = 'HelperTransportError';

  constructor(readonly code: HelperTransportErrorCode) {
    super(TRANSPORT_ERROR_MESSAGES[code]);
  }
}

export type HelperPermissionCommandErrorCode = 'permission_timeout';

export class HelperPermissionCommandError extends Error {
  readonly name = 'HelperPermissionCommandError';

  constructor(readonly code: HelperPermissionCommandErrorCode) {
    super('Capture helper permission command timed out.');
  }
}

type HelperProcessStartupErrorCode =
  | 'handshake_timeout'
  | 'protocol_invalid'
  | 'process_exit'
  | 'spawn_failed';

const STARTUP_ERROR_MESSAGES: Record<HelperProcessStartupErrorCode, string> = {
  handshake_timeout: 'Capture helper startup handshake timed out.',
  process_exit: 'Capture helper exited during startup.',
  protocol_invalid: 'Capture helper startup handshake failed.',
  spawn_failed: 'Capture helper failed to start.',
};

class HelperProcessStartupError extends Error {
  readonly name = 'HelperProcessStartupError';

  constructor(readonly code: HelperProcessStartupErrorCode) {
    super(STARTUP_ERROR_MESSAGES[code]);
  }
}

type PendingStartup = {
  child: HelperProcess;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: HelperProcessStartupError) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type HelperPolicyActivationErrorCode =
  | 'helper_unavailable'
  | 'policy_ack_mismatch'
  | 'policy_ack_timeout';

export class HelperPolicyActivationError extends Error {
  readonly name = 'HelperPolicyActivationError';

  constructor(readonly code: HelperPolicyActivationErrorCode) {
    super(
      code === 'policy_ack_mismatch'
        ? 'Capture helper applied a different policy.'
        : code === 'policy_ack_timeout'
          ? 'Capture helper policy acknowledgement timed out.'
          : 'Capture helper is unavailable.',
    );
  }
}

type PendingPolicyAck = {
  policyHash: string;
  policyVersion: string;
  reject: (error: HelperPolicyActivationError) => void;
  resolve: () => void;
  timeout: ReturnType<typeof setTimeout>;
};

type PermissionCommandType = 'permission.refresh' | 'permission.request_screen_capture';

type PendingPermissionCommand = {
  reject: (error: HelperPermissionCommandError | HelperTransportError) => void;
  resolve: (snapshot: HelperPermissionSnapshot) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type PendingStopWaiter = {
  child: HelperProcess;
  resolve: (exited: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
};

/**
 * Minimal structural surface of a child process this client depends on.
 * Kept narrow and duck-typed (rather than importing `ChildProcess` directly
 * everywhere) so unit tests can supply a lightweight fake instead of
 * spawning a real OS process; a real `node:child_process` `ChildProcess`
 * satisfies this type as-is.
 */
export type HelperProcess = {
  readonly pid?: number;
  readonly stdin: {
    write(chunk: string, callback: (error?: Error | null) => void): boolean;
  } | null;
  readonly stdout: NodeEventSource | null;
  readonly stderr: NodeEventSource | null;
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
};

type NodeEventSource = {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
};

export type SpawnHelperProcess = (
  command: string,
  args: string[],
  options: { detached: boolean; env: NodeJS.ProcessEnv },
) => HelperProcess;

export type HelperProcessClientOptions = {
  /** Path or command name of the helper executable. Injected, never hard-coded here. */
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /** How long to wait for a clean exit after `helper.shutdown` before SIGKILL. */
  shutdownTimeoutMs?: number;
  /** How long to wait for the first valid `helper.hello` before rejecting startup. */
  startupTimeoutMs?: number;
  now?: () => string;
  /** Dependency injection point for the underlying process spawn, defaults to `node:child_process`. */
  spawnHelperProcess?: SpawnHelperProcess;
  /** Test seam for POSIX process-group termination; production uses `process.kill(-pgid, signal)`. */
  forceKillProcessGroup?: (processGroupId: number, signal: NodeJS.Signals) => boolean;
  /**
   * Optional diagnostics hook for envelopes this process could not parse.
   * Never receives raw stdout bytes beyond what the protocol codec already
   * decided was safe to surface in a `HelperProtocolError`.
   */
  onProtocolError?: (error: HelperProtocolError) => void;
};

/**
 * Real, cross-process `CaptureHelperClient`. It owns a spawned helper
 * subprocess end to end: framing/decoding its stdout, encoding commands to
 * its stdin, and translating unexpected process death into the transport
 * event the lifecycle actor handles. It never exposes the child's pid, exact
 * executable path, or raw stdio bytes to callers — only parsed, already
 * privacy-checked protocol envelopes and safe classified events cross that
 * boundary.
 *
 * The returned client also implements `CaptureHelperCommandClient`
 * (`sendCommand`), the narrow interface `CaptureHelperEventHandler` depends on
 * to send `capture.ack` / `capture.nack` / backpressure `capture.pause`
 * replies back to the helper over the same stdio channel this client already
 * owns. Callers that only need `CaptureHelperClient` (start/stop/pause/
 * resume) are unaffected; this only adds capability, it does not change any
 * existing method's behavior.
 */
export function createHelperProcessClient(
  options: HelperProcessClientOptions,
): CaptureHelperClient &
  CaptureHelperCommandClient & {
    configureCapture(policy: HelperCapturePolicy, identity?: HelperCaptureIdentity): Promise<void>;
  } {
  return new HelperProcessClient(options);
}

class HelperProcessClient implements CaptureHelperClient, CaptureHelperCommandClient {
  private child: HelperProcess | undefined;
  private observer: CaptureHelperTransportObserver | undefined;
  private stopRequested = false;
  private pendingStartup: PendingStartup | undefined;
  private readonly pendingPolicyAcks = new Map<string, PendingPolicyAck>();
  private readonly pendingPermissionCommands = new Map<string, PendingPermissionCommand>();
  private readonly pendingStopWaiters = new Set<PendingStopWaiter>();
  private readonly exitedChildren = new WeakSet<HelperProcess>();
  private readonly expectedExitChildren = new WeakSet<HelperProcess>();
  private permissionCommandSequence = 0;

  constructor(private readonly options: HelperProcessClientOptions) {}

  async start(observer: CaptureHelperTransportObserver): Promise<void> {
    if (this.child) {
      if (this.pendingStartup?.child === this.child) {
        return this.pendingStartup.promise;
      }
      return;
    }

    this.observer = observer;
    this.stopRequested = false;

    const spawnFn = this.options.spawnHelperProcess ?? defaultSpawnHelperProcess;
    let child: HelperProcess;
    try {
      child = spawnFn(this.options.command, this.options.args ?? [], {
        detached: process.platform !== 'win32',
        env: { ...processEnvSafeCopy(), ...this.options.env },
      });
    } catch {
      throw new HelperProcessStartupError('spawn_failed');
    }
    this.child = child;

    let resolveStartup: (() => void) | undefined;
    let rejectStartup: ((error: HelperProcessStartupError) => void) | undefined;
    const startupPromise = new Promise<void>((resolve, reject) => {
      resolveStartup = resolve;
      rejectStartup = reject;
    });
    const timeout = setTimeout(
      () => this.rejectStartup(child, 'handshake_timeout'),
      this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    );
    this.pendingStartup = {
      child,
      promise: startupPromise,
      reject: rejectStartup as (error: HelperProcessStartupError) => void,
      resolve: resolveStartup as () => void,
      timeout,
    };

    const lineParser = new HelperNdjsonLineParser(validateHelperToMainEnvelope);
    child.stdout?.on('data', (chunk) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const result of lineParser.feed(text)) {
        this.handleParsedLine(child, result);
      }
    });

    child.on('exit', (code, signal) => this.handleExit(child, code, signal));
    child.on('error', () => this.handleSpawnError(child));

    return startupPromise;
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.rejectPermissionCommands('helper_unavailable');
    const child = this.child;

    if (!child) {
      return;
    }

    try {
      await this.writeCommand(child, 'helper.shutdown', { reason: 'quit' });
      if (
        await this.waitForExit(child, this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS)
      ) {
        return;
      }
    } catch {
      // A failed shutdown write makes graceful termination impossible. The
      // same exit-confirmed force-termination path below remains authoritative.
    }

    if (!this.exitedChildren.has(child)) {
      try {
        this.forceKill(child);
      } catch {
        // Shutdown success is decided only by the child's exit event. Signal
        // failures are intentionally contained so no OS detail can escape.
      }
    }

    if (await this.waitForExit(child, FORCE_KILL_GRACE_MS)) {
      return;
    }

    throw new HelperTransportError('helper_shutdown_failed');
  }

  async beginCapture(reason: 'runtime_started' | 'user_resumed'): Promise<void> {
    await this.writeCommand(this.requireConnectedChild(), 'capture.start', { reason });
  }

  async configureCapture(
    policy: HelperCapturePolicy,
    identity?: HelperCaptureIdentity,
  ): Promise<void> {
    let child: HelperProcess;
    try {
      child = this.requireConnectedChild();
    } catch {
      throw new HelperPolicyActivationError('helper_unavailable');
    }

    const correlationId = `policy_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const acknowledgement = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.rejectPolicyAck(correlationId, 'policy_ack_timeout');
      }, DEFAULT_POLICY_ACK_TIMEOUT_MS);
      this.pendingPolicyAcks.set(correlationId, {
        policyHash: policy.policyHash,
        policyVersion: policy.version,
        reject,
        resolve,
        timeout,
      });
    });

    try {
      await this.writeCommand(
        child,
        'helper.configure',
        {
          ...(identity ? { captureIdentity: identity } : {}),
          policy,
        },
        correlationId,
      );
    } catch {
      this.rejectPolicyAck(correlationId, 'helper_unavailable');
      return await acknowledgement;
    }

    return await acknowledgement;
  }

  async pauseCapture(): Promise<void> {
    await this.writeCommand(this.requireConnectedChild(), 'capture.pause', {
      reason: 'user_paused',
    });
  }

  async resumeCapture(): Promise<void> {
    await this.writeCommand(this.requireConnectedChild(), 'capture.resume', {
      reason: 'user_resumed',
    });
  }

  async refreshPermissions(
    options: HelperPermissionCommandOptions = {},
  ): Promise<HelperPermissionSnapshot> {
    return await this.sendPermissionCommand(
      'permission.refresh',
      options.timeoutMs ?? DEFAULT_PERMISSION_REFRESH_TIMEOUT_MS,
    );
  }

  async requestScreenRecordingPermission(
    options: HelperPermissionCommandOptions = {},
  ): Promise<HelperPermissionSnapshot> {
    return await this.sendPermissionCommand(
      'permission.request_screen_capture',
      options.timeoutMs ?? DEFAULT_SCREEN_RECORDING_REQUEST_TIMEOUT_MS,
    );
  }

  /**
   * Generic command channel for `CaptureHelperEventHandler`, which already
   * builds a fully-formed envelope (`capture.ack` / `capture.nack` /
   * backpressure `capture.pause`) and only needs it written to the helper's
   * stdin. This never inspects or rewrites the envelope, so it cannot drift
   * from the header fields the event handler already set.
   */
  async sendCommand(command: HelperEnvelope<MainToHelperType>): Promise<void> {
    await this.writeEncodedCommand(this.requireConnectedChild(), encodeHelperEnvelope(command));
  }

  private requireConnectedChild(): HelperProcess {
    const child = this.child;
    if (!child || !child.stdin || this.exitedChildren.has(child) || this.stopRequested) {
      throw new HelperTransportError('helper_unavailable');
    }

    return child;
  }

  private async sendPermissionCommand(
    type: PermissionCommandType,
    timeoutMs: number,
  ): Promise<HelperPermissionSnapshot> {
    const child = this.requireConnectedChild();
    const correlationId = this.nextPermissionCorrelationId(type);
    const completion = new Promise<HelperPermissionSnapshot>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.rejectPermissionCommand(correlationId, 'permission_timeout');
      }, timeoutMs);
      this.pendingPermissionCommands.set(correlationId, { reject, resolve, timeout });
    });

    try {
      await this.writeCommand(child, type, {}, correlationId);
    } catch {
      this.rejectPermissionCommand(correlationId, 'helper_unavailable');
    }

    return await completion;
  }

  private async writeEncodedCommand(child: HelperProcess, encodedCommand: string): Promise<void> {
    const stdin = child.stdin;
    if (this.child !== child || !stdin || this.exitedChildren.has(child)) {
      throw new HelperTransportError('helper_unavailable');
    }

    return await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (error) {
          reject(new HelperTransportError('helper_unavailable'));
          return;
        }
        resolve();
      };

      try {
        stdin.write(encodedCommand, settle);
      } catch {
        settle(new Error());
      }
    });
  }

  private handleParsedLine(
    child: HelperProcess,
    result: HelperProtocolResult<HelperToMainEnvelope>,
  ): void {
    if (this.child !== child) {
      return;
    }

    if (result.ok) {
      if (this.pendingStartup?.child === child) {
        if (result.envelope.type !== 'helper.hello') {
          this.rejectStartup(child, 'protocol_invalid');
          return;
        }
        this.resolveStartup(child);
      }

      if (result.envelope.type === 'helper.policy_applied') {
        this.resolvePolicyAck(result.envelope as HelperEnvelope<'helper.policy_applied'>);
      }

      if (result.envelope.type === 'permission.status') {
        this.resolvePermissionCommand(result.envelope as HelperEnvelope<'permission.status'>);
      }

      this.dispatch({ type: 'envelope', envelope: result.envelope });
      return;
    }

    if (this.pendingStartup?.child === child) {
      this.rejectStartup(child, 'protocol_invalid');
    }
    this.options.onProtocolError?.(result.error);
  }

  private handleExit(
    child: HelperProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    this.exitedChildren.add(child);
    this.settlePendingStopWaiters(child);
    this.rejectPermissionCommands('helper_unavailable');

    if (this.pendingStartup?.child === child) {
      this.rejectStartup(child, 'process_exit', false);
      return;
    }

    if (this.expectedExitChildren.delete(child) || this.child !== child) {
      return;
    }

    const wasStopRequested = this.stopRequested;
    this.child = undefined;
    this.rejectPolicyAcks('helper_unavailable');
    this.rejectPermissionCommands('helper_unavailable');

    if (wasStopRequested) {
      return;
    }

    this.dispatch({
      code: code ?? null,
      reason: classifyUnexpectedExitReason(code, signal),
      type: 'process_exit',
    });
  }

  private handleSpawnError(child: HelperProcess): void {
    if (this.pendingStartup?.child === child) {
      this.rejectStartup(child, 'spawn_failed');
      return;
    }

    if (this.child !== child) {
      return;
    }

    const wasStopRequested = this.stopRequested;
    this.child = undefined;
    this.rejectPolicyAcks('helper_unavailable');

    if (wasStopRequested) {
      return;
    }

    // Deliberately no `error` detail here: spawn errors (e.g. ENOENT) often
    // embed the full executable path, which must never leak past this
    // client into the business layer or its logs.
    this.dispatch({
      code: null,
      reason: 'unknown',
      type: 'process_exit',
    });
  }

  private resolveStartup(child: HelperProcess): void {
    const startup = this.pendingStartup;
    if (!startup || startup.child !== child) {
      return;
    }

    clearTimeout(startup.timeout);
    this.pendingStartup = undefined;
    startup.resolve();
  }

  private dispatch(event: Parameters<CaptureHelperTransportObserver['handle']>[0]): void {
    const observer = this.observer;
    if (!observer) return;
    void observer.handle(event).catch(() => {
      const child = this.child;
      if (!child || this.stopRequested) return;
      try {
        this.forceKill(child);
      } catch {
        child.kill('SIGKILL');
      }
    });
  }

  private rejectStartup(
    child: HelperProcess,
    code: HelperProcessStartupErrorCode,
    terminateChild = true,
  ): void {
    const startup = this.pendingStartup;
    if (!startup || startup.child !== child) {
      return;
    }

    clearTimeout(startup.timeout);
    this.pendingStartup = undefined;
    if (this.child === child) {
      this.child = undefined;
    }
    this.rejectPolicyAcks('helper_unavailable');
    this.rejectPermissionCommands('helper_unavailable');

    if (terminateChild) {
      this.expectedExitChildren.add(child);
      this.forceKill(child);
    }

    startup.reject(new HelperProcessStartupError(code));
  }

  private settlePendingStopWaiters(child: HelperProcess): void {
    for (const waiter of this.pendingStopWaiters) {
      if (waiter.child !== child) {
        continue;
      }
      clearTimeout(waiter.timeout);
      this.pendingStopWaiters.delete(waiter);
      waiter.resolve(true);
    }
  }

  private waitForExit(child: HelperProcess, timeoutMs: number): Promise<boolean> {
    if (this.exitedChildren.has(child)) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const waiter: PendingStopWaiter = {
        child,
        resolve,
        timeout: setTimeout(() => {
          this.pendingStopWaiters.delete(waiter);
          resolve(false);
        }, timeoutMs),
      };
      this.pendingStopWaiters.add(waiter);
    });
  }

  private async writeCommand<TType extends MainToHelperType>(
    child: HelperProcess,
    type: TType,
    payload: MainToHelperPayloadByType[TType],
    correlationId: string | null = null,
  ): Promise<void> {
    const envelope = {
      correlationId,
      messageId: `main_${type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      payload,
      protocolVersion: HELPER_PROTOCOL_VERSION,
      sentAt: this.options.now?.() ?? new Date().toISOString(),
      type,
    } as HelperEnvelope<TType>;

    await this.writeEncodedCommand(child, encodeHelperEnvelope(envelope));
  }

  private resolvePolicyAck(envelope: HelperEnvelope<'helper.policy_applied'>): void {
    const correlationId = envelope.correlationId;
    if (!correlationId) {
      return;
    }
    const pending = this.pendingPolicyAcks.get(correlationId);
    if (!pending) {
      return;
    }
    if (
      pending.policyHash !== envelope.payload.policyHash ||
      pending.policyVersion !== envelope.payload.policyVersion
    ) {
      this.rejectPolicyAck(correlationId, 'policy_ack_mismatch');
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingPolicyAcks.delete(correlationId);
    pending.resolve();
  }

  private rejectPolicyAck(correlationId: string, code: HelperPolicyActivationErrorCode): void {
    const pending = this.pendingPolicyAcks.get(correlationId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingPolicyAcks.delete(correlationId);
    pending.reject(new HelperPolicyActivationError(code));
  }

  private rejectPolicyAcks(code: HelperPolicyActivationErrorCode): void {
    for (const correlationId of this.pendingPolicyAcks.keys()) {
      this.rejectPolicyAck(correlationId, code);
    }
  }

  private nextPermissionCorrelationId(type: PermissionCommandType): string {
    this.permissionCommandSequence += 1;
    return `permission_${type.replaceAll('.', '_')}_${this.permissionCommandSequence}`;
  }

  private resolvePermissionCommand(envelope: HelperEnvelope<'permission.status'>): void {
    const correlationId = envelope.correlationId;
    if (!correlationId) {
      return;
    }

    const pending = this.pendingPermissionCommands.get(correlationId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingPermissionCommands.delete(correlationId);
    pending.resolve({
      accessibility: envelope.payload.accessibility,
      screenRecording: envelope.payload.screenCapture,
    });
  }

  private rejectPermissionCommand(
    correlationId: string,
    code: HelperPermissionCommandErrorCode | 'helper_unavailable',
  ): void {
    const pending = this.pendingPermissionCommands.get(correlationId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingPermissionCommands.delete(correlationId);
    pending.reject(
      code === 'permission_timeout'
        ? new HelperPermissionCommandError(code)
        : new HelperTransportError(code),
    );
  }

  private rejectPermissionCommands(
    code: HelperPermissionCommandErrorCode | 'helper_unavailable',
  ): void {
    for (const correlationId of this.pendingPermissionCommands.keys()) {
      this.rejectPermissionCommand(correlationId, code);
    }
  }

  private forceKill(child: HelperProcess): void {
    const processId = child.pid;
    if (process.platform !== 'win32' && processId && processId > 0) {
      const killProcessGroup = this.options.forceKillProcessGroup ?? defaultForceKillProcessGroup;
      try {
        if (killProcessGroup(processId, 'SIGKILL')) {
          return;
        }
      } catch {
        // The process may have exited between the timeout and the signal. Fall
        // back to the direct handle so stop() remains idempotent and bounded.
      }
    }

    child.kill('SIGKILL');
  }
}

function classifyUnexpectedExitReason(
  code: number | null,
  signal: NodeJS.Signals | null,
): 'process_crashed' | 'unknown' {
  if (signal) {
    return 'process_crashed';
  }

  if (code !== null && code !== 0) {
    return 'process_crashed';
  }

  return 'unknown';
}

function defaultSpawnHelperProcess(
  command: string,
  args: string[],
  options: { detached: boolean; env: NodeJS.ProcessEnv },
): HelperProcess {
  return nodeSpawn(command, args, {
    detached: options.detached,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function defaultForceKillProcessGroup(processGroupId: number, signal: NodeJS.Signals): boolean {
  return process.kill(-processGroupId, signal);
}

function processEnvSafeCopy(): NodeJS.ProcessEnv {
  return { ...process.env };
}
