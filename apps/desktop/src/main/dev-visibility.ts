import type { HelperEnvelope, HelperToMainType } from '../helper/index';
import { redactSensitiveString } from '../logging/redaction';
import type { SyncRunResult } from '../sync/index';

export type DevVisibilityLogger = {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

export type DevVisibilityOptions = {
  logger?: DevVisibilityLogger;
};

export type DevVisibility = {
  onHelperEnvelope(envelope: HelperEnvelope<HelperToMainType>): void;
  onSyncResult(result: SyncRunResult): void;
  onSyncError(error: unknown): void;
};

export function createDevVisibility(options: DevVisibilityOptions = {}): DevVisibility {
  const logger = options.logger ?? console;

  return {
    onHelperEnvelope(envelope) {
      logHelperEnvelope(logger, envelope);
    },
    onSyncError(_error) {
      logger.error('[recapsy:sync] error');
    },
    onSyncResult(result) {
      logSyncResult(logger, result);
    },
  };
}

function logHelperEnvelope(
  logger: DevVisibilityLogger,
  envelope: HelperEnvelope<HelperToMainType>,
): void {
  switch (envelope.type) {
    case 'capture.result': {
      const { captureId, assets } = narrowHelperEnvelope(envelope, 'capture.result').payload;
      const [screenshot] = assets;
      const assetInfo = `${safeDiagnosticValue(screenshot.mimeType)} ${screenshot.sizeBytes}B`;
      logger.log(
        `[recapsy:capture] result captureId=${safeDiagnosticValue(captureId)} assets=${assets.length} ${assetInfo}`,
      );
      return;
    }
    case 'capture.skipped': {
      const payload = narrowHelperEnvelope(envelope, 'capture.skipped').payload;
      logger.log(
        `[recapsy:capture] skipped captureId=${safeDiagnosticValue(payload.captureId)} reason=${payload.reason}`,
      );
      return;
    }
    case 'capture.error': {
      const payload = narrowHelperEnvelope(envelope, 'capture.error').payload;
      logger.log(
        `[recapsy:capture] error code=${payload.code}${
          payload.captureId ? ` captureId=${safeDiagnosticValue(payload.captureId)}` : ''
        }`,
      );
      return;
    }
    case 'helper.exiting': {
      const payload = narrowHelperEnvelope(envelope, 'helper.exiting').payload;
      logger.log(
        `[recapsy:capture] helper exiting reason=${payload.reason} code=${payload.code ?? 'null'}`,
      );
      return;
    }
    case 'permission.status': {
      const payload = narrowHelperEnvelope(envelope, 'permission.status').payload;
      logger.log(
        `[recapsy:capture] permissions accessibility=${payload.accessibility} screenRecording=${payload.screenCapture}`,
      );
      return;
    }
    case 'helper.hello': {
      const payload = narrowHelperEnvelope(envelope, 'helper.hello').payload;
      logger.log(
        `[recapsy:capture] helper hello version=${safeDiagnosticValue(payload.helperVersion)} pid=${payload.pid ?? 'unknown'}`,
      );
      return;
    }
    case 'helper.status': {
      const payload = narrowHelperEnvelope(envelope, 'helper.status').payload;
      logger.log(
        `[recapsy:capture] helper status=${payload.status}${
          payload.reason ? ` reason=${safeDiagnosticValue(payload.reason)}` : ''
        }`,
      );
      return;
    }
    case 'helper.heartbeat':
      return;
  }
}

function logSyncResult(logger: DevVisibilityLogger, result: SyncRunResult): void {
  if (result.status === 'idle') {
    return;
  }

  const parts = [`status=${result.status}`];

  if (result.jobId) {
    parts.push(`jobId=${safeDiagnosticValue(result.jobId)}`);
  }

  if (result.code) {
    parts.push(`code=${result.code}`);
  }

  logger.log(`[recapsy:sync] ${parts.join(' ')}`);
}

function narrowHelperEnvelope<TType extends HelperToMainType>(
  envelope: HelperEnvelope<HelperToMainType>,
  _type: TType,
): HelperEnvelope<TType> {
  return envelope as HelperEnvelope<TType>;
}

function safeDiagnosticValue(value: string): string {
  const redacted = redactSensitiveString(value);
  if (redacted !== value) {
    return redacted;
  }
  if (/(?:bearer|credential|password|secret|token)/i.test(value)) {
    return '[redacted:secret]';
  }
  if (value.includes('/') || value.includes('\\')) {
    return '[redacted:path]';
  }
  return value;
}
