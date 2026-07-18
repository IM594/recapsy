#!/usr/bin/env bun
/**
 * Dev-only stand-in for the future Swift ScreenCaptureKit capture helper.
 *
 * This is NOT a real capture helper. It never touches the screen, the
 * filesystem, or any OS permission. Its only job is to exist as a real,
 * separate OS process that speaks the exact same stdio NDJSON protocol
 * (`../helper/protocol/codec.ts`) the real Swift helper will speak, so that
 * `createHelperProcessClient` (see `./process-client.ts`) and the
 * Electron main runtime around it can be exercised across a genuine process
 * boundary before the Swift binary exists.
 *
 * Protocol handling in this file always goes through
 * `encodeHelperEnvelope` and `HelperNdjsonLineParser` from
 * `./protocol/codec.ts` — this module does not
 * invent its own serialization.
 *
 * Synthesizing a `capture.result` for tests: `MainToHelperPayloadByType`
 * intentionally has no "please pretend to capture now" message, because that
 * would pollute the real main<->helper protocol contract with a command the
 * real Swift helper would never implement. Instead this process listens for
 * `SIGUSR2` and emits one synthetic `capture.result` per signal. SIGUSR2 is:
 *   - Outside the stdio channel entirely, so the protocol contract used by
 *     the real helper stays untouched.
 *   - Trivial for an integration test to trigger: it already holds the
 *     `ChildProcess` handle it spawned and can call `child.kill('SIGUSR2')`.
 *   - A standard POSIX facility every spawned child already supports, with
 *     no extra IPC plumbing required.
 */
import { createSafeCaptureResultPayload } from './capture-result';
import { HelperNdjsonLineParser, encodeHelperEnvelope } from './protocol/codec';
import {
  HELPER_PROTOCOL_VERSION,
  type HelperEnvelope,
  type HelperProtocolResult,
  type HelperToMainType,
  type MainToHelperEnvelope,
} from './protocol/types';
import { validateMainToHelperEnvelope } from './protocol/validation';

const HELPER_VERSION = 'dev-process/0.1.0';

export type DevHelperCaptureState = 'starting' | 'ready' | 'paused';

export type DevHelperRuntimeOptions = {
  now?: () => string;
  emit: (line: string) => void;
};

export type DevHelperRuntime = {
  getState(): DevHelperCaptureState;
  isShutdown(): boolean;
  start(): void;
  heartbeat(): void;
  synthesizeCapture(): HelperEnvelope<'capture.result'>;
  handleEnvelope(result: HelperProtocolResult<MainToHelperEnvelope>): void;
};

/**
 * Pure, spawn-free core of the dev helper. Kept separate from the stdio
 * wiring below so the command-handling state machine can be unit tested
 * with `bun test` without spawning a real OS process — real cross-process
 * behavior (stdout framing, signals, process exit) is covered instead by
 * the integration test that spawns this file for real.
 */
export function createDevHelperRuntime(options: DevHelperRuntimeOptions): DevHelperRuntime {
  const now = options.now ?? (() => new Date().toISOString());
  let state: DevHelperCaptureState = 'starting';
  let shutdown = false;
  let messageSequence = 0;
  let captureSequence = 0;
  let policyVersion = 'dev-helper-unconfigured';

  function emitEnvelope<TType extends HelperToMainType>(
    type: TType,
    payload: HelperEnvelope<TType>['payload'],
    correlationId: string | null = null,
  ): HelperEnvelope<TType> {
    messageSequence += 1;
    const envelope: HelperEnvelope<TType> = {
      correlationId,
      messageId: `dev_helper_${messageSequence}`,
      payload,
      protocolVersion: HELPER_PROTOCOL_VERSION,
      sentAt: now(),
      type,
    };
    options.emit(encodeHelperEnvelope(envelope));
    return envelope;
  }

  return {
    getState() {
      return state;
    },

    handleEnvelope(result) {
      if (!result.ok) {
        // Malformed or unsupported input on stdin must never crash a helper
        // process. A real Swift helper would be equally expected to ignore
        // or safely reject input it cannot parse.
        return;
      }

      const envelope = result.envelope;

      switch (envelope.type) {
        case 'helper.configure': {
          const configure = envelope as HelperEnvelope<'helper.configure'>;
          policyVersion = configure.payload.policy.version;
          emitEnvelope(
            'helper.policy_applied',
            {
              policyHash: configure.payload.policy.policyHash,
              policyVersion,
            },
            configure.correlationId,
          );
          return;
        }
        case 'permission.refresh':
        case 'permission.request_screen_capture':
          // This development-only process has no native TCC integration. It
          // still returns a fresh observation so the Electron protocol paths
          // remain testable, but it never attempts to summon a system prompt.
          emitEnvelope('permission.status', {
            accessibility: 'not_determined',
            observedAt: now(),
            screenCapture: 'not_determined',
          });
          return;
        case 'capture.start':
          state = 'ready';
          emitEnvelope('helper.status', { status: 'ready' });
          return;
        case 'capture.pause': {
          const pause = envelope as HelperEnvelope<'capture.pause'>;
          state = 'paused';
          emitEnvelope('helper.status', { status: 'paused', reason: pause.payload.reason });
          return;
        }
        case 'capture.resume': {
          const resume = envelope as HelperEnvelope<'capture.resume'>;
          state = 'ready';
          emitEnvelope('helper.status', { status: 'ready', reason: resume.payload.reason });
          return;
        }
        case 'capture.flush':
        case 'capture.ack':
        case 'capture.nack':
          // The dev helper never buffers a capture waiting for
          // acknowledgement — it emits one `capture.result` per SIGUSR2 and
          // forgets about it. There is nothing to flush or reconcile here;
          // a real Swift helper would flush pending manifests to disk.
          return;
        case 'helper.shutdown':
          shutdown = true;
          emitEnvelope('helper.exiting', { code: 0, reason: 'shutdown_requested' });
          return;
        default:
          return;
      }
    },

    heartbeat() {
      messageSequence += 1;
      emitEnvelope('helper.heartbeat', {
        sequence: messageSequence,
        status: state === 'starting' ? 'starting' : state === 'paused' ? 'paused' : 'ready',
      });
    },

    isShutdown() {
      return shutdown;
    },

    start() {
      emitEnvelope('helper.hello', {
        capabilities: {
          capture: true,
          mock: true,
          permissions: false,
        },
        helperVersion: HELPER_VERSION,
        pid: typeof process !== 'undefined' ? process.pid : null,
      });
    },

    synthesizeCapture() {
      captureSequence += 1;
      const captureId = `dev_capture_${captureSequence}`;
      const observedAt = now();
      const payload = createSafeCaptureResultPayload({
        application: {
          bundleId: 'one.recapsy.desktop.dev-helper',
          name: 'Recapsy Dev Helper',
        },
        assetRef: `dev_asset_${captureSequence}`,
        captureId,
        hash: `dev_hash_${captureSequence}`,
        manifestRef: `dev_manifest_${captureSequence}`,
        mimeType: 'image/png',
        observedAt,
        sizeBytes: 1024,
      });
      // Thread the last configured policy version through so a synthesized
      // capture reflects the same `helper.configure` state a real helper
      // would honor, instead of the projection helper's generic default.
      return emitEnvelope('capture.result', {
        ...payload,
        context: {
          ...payload.context,
          policy: { ...payload.context.policy, version: policyVersion },
        },
      });
    },
  };
}

if (import.meta.main) {
  runDevHelperProcess();
}

function runDevHelperProcess(): void {
  const runtime = createDevHelperRuntime({
    emit: (line) => {
      process.stdout.write(line);
    },
  });

  const heartbeatIntervalMs = parsePositiveInt(process.env.DEV_HELPER_HEARTBEAT_INTERVAL_MS, 250);
  const heartbeatTimer = setInterval(() => runtime.heartbeat(), heartbeatIntervalMs);

  const stdinParser = new HelperNdjsonLineParser(validateMainToHelperEnvelope);

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    for (const result of stdinParser.feed(chunk)) {
      runtime.handleEnvelope(result);

      if (runtime.isShutdown()) {
        clearInterval(heartbeatTimer);
        process.exit(0);
      }
    }
  });

  process.on('SIGUSR2', () => {
    runtime.synthesizeCapture();
  });

  runtime.start();
  process.stdin.resume();
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
