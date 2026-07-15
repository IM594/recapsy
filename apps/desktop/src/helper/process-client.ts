import { spawn as nodeSpawn } from 'node:child_process';
import { HelperNdjsonLineParser, encodeHelperEnvelope } from './protocol/codec';
import {
  HELPER_PROTOCOL_VERSION,
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
  CaptureHelperStartOptions,
} from './types';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3000;
const FORCE_KILL_GRACE_MS = 1000;

/**
 * Minimal structural surface of a child process this client depends on.
 * Kept narrow and duck-typed (rather than importing `ChildProcess` directly
 * everywhere) so unit tests can supply a lightweight fake instead of
 * spawning a real OS process; a real `node:child_process` `ChildProcess`
 * satisfies this type as-is.
 */
export type HelperProcess = {
  readonly pid?: number;
  readonly stdin: { write(chunk: string): boolean } | null;
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
 * its stdin, and translating unexpected process death into the
 * `unexpectedExit` event the business layer (`CaptureHelperController`)
 * already knows how to handle. It never exposes the child's pid, exact
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
): CaptureHelperClient & CaptureHelperCommandClient {
  return new HelperProcessClient(options);
}

class HelperProcessClient implements CaptureHelperClient, CaptureHelperCommandClient {
  private child: HelperProcess | undefined;
  private startOptions: CaptureHelperStartOptions = {};
  private stopRequested = false;
  private pendingStopResolvers: Array<() => void> = [];

  constructor(private readonly options: HelperProcessClientOptions) {}

  async start(startOptions: CaptureHelperStartOptions = {}): Promise<void> {
    if (this.child) {
      return;
    }

    this.startOptions = startOptions;
    this.stopRequested = false;

    const spawnFn = this.options.spawnHelperProcess ?? defaultSpawnHelperProcess;
    const child = spawnFn(this.options.command, this.options.args ?? [], {
      detached: process.platform !== 'win32',
      env: { ...processEnvSafeCopy(), ...this.options.env },
    });
    this.child = child;

    const lineParser = new HelperNdjsonLineParser(validateHelperToMainEnvelope);
    child.stdout?.on('data', (chunk) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const result of lineParser.feed(text)) {
        this.handleParsedLine(result);
      }
    });

    child.on('exit', (code, signal) => this.handleExit(code, signal));
    child.on('error', () => this.handleSpawnError());
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    const child = this.child;

    if (!child) {
      return;
    }

    this.writeCommand(child, 'helper.shutdown', { reason: 'quit' });

    const exitedGracefully = await this.waitForExit(
      child,
      this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    );

    if (!exitedGracefully && this.child === child) {
      this.forceKill(child);
      await this.waitForExit(child, FORCE_KILL_GRACE_MS);
    }
  }

  async beginCapture(reason: 'runtime_started' | 'user_resumed'): Promise<void> {
    if (this.child) {
      this.writeCommand(this.child, 'capture.start', { reason });
    }
  }

  async pauseCapture(): Promise<void> {
    if (this.child) {
      this.writeCommand(this.child, 'capture.pause', { reason: 'user_paused' });
    }
  }

  async resumeCapture(): Promise<void> {
    if (this.child) {
      this.writeCommand(this.child, 'capture.resume', { reason: 'user_resumed' });
    }
  }

  /**
   * Generic command channel for `CaptureHelperEventHandler`, which already
   * builds a fully-formed envelope (`capture.ack` / `capture.nack` /
   * backpressure `capture.pause`) and only needs it written to the helper's
   * stdin. This never inspects or rewrites the envelope, so it cannot drift
   * from the header fields the event handler already set.
   */
  async sendCommand(command: HelperEnvelope<MainToHelperType>): Promise<void> {
    if (this.child) {
      this.child.stdin?.write(encodeHelperEnvelope(command));
    }
  }

  private handleParsedLine(result: HelperProtocolResult<HelperToMainEnvelope>): void {
    if (result.ok) {
      void this.startOptions.onEnvelope?.(result.envelope);
      return;
    }

    this.options.onProtocolError?.(result.error);
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasStopRequested = this.stopRequested;
    this.child = undefined;
    this.settlePendingStopWaiters();

    if (wasStopRequested) {
      return;
    }

    void this.startOptions.onEvent?.({
      code: code ?? null,
      reason: classifyUnexpectedExitReason(code, signal),
      type: 'unexpectedExit',
    });
  }

  private handleSpawnError(): void {
    const wasStopRequested = this.stopRequested;
    this.child = undefined;
    this.settlePendingStopWaiters();

    if (wasStopRequested) {
      return;
    }

    // Deliberately no `error` message here: spawn errors (e.g. ENOENT) often
    // embed the full executable path, which must never leak past this
    // client into the business layer or its logs.
    void this.startOptions.onEvent?.({
      code: null,
      reason: 'unknown',
      type: 'unexpectedExit',
    });
  }

  private settlePendingStopWaiters(): void {
    const resolvers = this.pendingStopResolvers.splice(0);
    for (const resolve of resolvers) {
      resolve();
    }
  }

  private waitForExit(child: HelperProcess, timeoutMs: number): Promise<boolean> {
    if (this.child !== child) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      }, timeoutMs);

      this.pendingStopResolvers.push(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(true);
        }
      });
    });
  }

  private writeCommand<TType extends MainToHelperType>(
    child: HelperProcess,
    type: TType,
    payload: MainToHelperPayloadByType[TType],
  ): void {
    const envelope = {
      correlationId: null,
      messageId: `main_${type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      payload,
      protocolVersion: HELPER_PROTOCOL_VERSION,
      sentAt: this.options.now?.() ?? new Date().toISOString(),
      type,
    } as HelperEnvelope<TType>;

    child.stdin?.write(encodeHelperEnvelope(envelope));
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
