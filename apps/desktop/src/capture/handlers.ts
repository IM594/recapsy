import type { CaptureHelperState } from '../helper/index';
import {
  type CaptureEventSummaryDto,
  type CaptureStatusDto,
  IPC_ERROR_CODES,
  type IpcError,
  type IpcErrorCode,
  type IpcHandlerMap,
  type LocalCapturePolicyRulesDto,
  createRendererSafeSuccess,
} from '../ipc/index';
import type { OutboxJob, SafeOperationalError } from '../storage/index';
import type { CaptureAdmissionController } from './admission';
import type { CaptureHelperEventHandler } from './helper-event-handler';
import type { CaptureLifecycle } from './lifecycle';
import type { LocalCapturePolicyManager } from './local-policy';
import type { CaptureHistoryReader } from './store';

export type CaptureIpcHandlerOptions = {
  admission?: CaptureAdmissionController;
  eventHandler: CaptureHelperEventHandler;
  lifecycle: CaptureLifecycle;
  localPolicy?: LocalCapturePolicyManager;
  store: CaptureHistoryReader;
  workspaceId: string;
};

export function createCaptureIpcHandlers(options: CaptureIpcHandlerOptions): IpcHandlerMap {
  const localPolicy = options.localPolicy;
  return {
    'capture.getStatus': async () => createRendererSafeSuccess(buildCaptureStatusDto(options)),
    'capture.getRecentEvents': async (payload) =>
      createRendererSafeSuccess(await buildRecentEventsDto(options, payload as { limit?: number })),
    'capture.pause': async () => {
      await options.lifecycle.pause();
      return createRendererSafeSuccess(buildCaptureStatusDto(options));
    },
    'capture.resume': async () => {
      await options.lifecycle.resume();
      return createRendererSafeSuccess(buildCaptureStatusDto(options));
    },
    ...(localPolicy
      ? {
          'capture.listLocalRules': async () =>
            createRendererSafeSuccess(await buildLocalRulesDto(localPolicy)),
          'capture.blockBundle': async (payload: unknown) => {
            await localPolicy.blockBundle((payload as { bundleId: string }).bundleId);
            return createRendererSafeSuccess(await buildLocalRulesDto(localPolicy));
          },
          'capture.removeLocalRule': async (payload: unknown) => {
            await localPolicy.remove((payload as { ruleId: string }).ruleId);
            return createRendererSafeSuccess(await buildLocalRulesDto(localPolicy));
          },
        }
      : {}),
  };
}

async function buildLocalRulesDto(
  manager: LocalCapturePolicyManager,
): Promise<LocalCapturePolicyRulesDto> {
  return {
    rules: (await manager.list()).map((rule) => ({
      bundleId: rule.pattern,
      enabled: rule.enabled,
      id: rule.id,
    })),
  };
}

function buildCaptureStatusDto(options: CaptureIpcHandlerOptions): CaptureStatusDto {
  const snapshot = options.lifecycle.getSnapshot();
  const helperStatus = snapshot.captureHelper;
  const eventStatus = options.eventHandler.getStatus();
  const permissions = eventStatus.permissions ?? {
    accessibility: 'unknown',
    screenRecording: 'unknown',
  };
  const lastSafeError = helperStatus?.lastSafeError ?? eventStatus.lastSafeError;
  const admission = options.admission?.getStatus();

  return {
    paused: snapshot.status === 'paused',
    ...(snapshot.pauseReason ? { pauseReason: snapshot.pauseReason } : {}),
    permissions,
    recentEventCount: 0,
    state: toCaptureStatusState(helperStatus?.state),
    ...(admission
      ? {
          admission: {
            active: admission.active,
            reasons: [...admission.reasons],
          },
        }
      : {}),
    ...(helperStatus?.policyHash && helperStatus.policyVersion
      ? {
          policy: {
            hash: helperStatus.policyHash,
            version: helperStatus.policyVersion,
          },
        }
      : {}),
    ...(lastSafeError ? { lastError: toIpcError(lastSafeError) } : {}),
  };
}

async function buildRecentEventsDto(
  options: CaptureIpcHandlerOptions,
  payload: { limit?: number },
): Promise<{ events: CaptureEventSummaryDto[] }> {
  const jobs = await options.store.listOutboxJobs({ workspaceId: options.workspaceId });
  const events = jobs
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, payload.limit ?? 50)
    .map(toCaptureEventSummaryDto);

  return { events };
}

function toCaptureEventSummaryDto(job: OutboxJob): CaptureEventSummaryDto {
  const reason = job.terminalReason ?? job.lastSafeError?.code;

  return {
    id: job.id,
    observedAt: job.capture.observedAt,
    state: toCaptureEventState(job.state),
    ...(reason ? { reason } : {}),
  };
}

function toCaptureEventState(state: OutboxJob['state']): CaptureEventSummaryDto['state'] {
  switch (state) {
    case 'pending':
    case 'syncing':
    case 'result_pending':
    case 'synced':
      return 'accepted';
    case 'blocked':
      return 'blocked';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'skipped';
  }
}

function toCaptureStatusState(state: CaptureHelperState | undefined): CaptureStatusDto['state'] {
  switch (state) {
    case 'running':
      return 'capturing';
    case 'paused':
      return 'paused';
    case 'failed':
    case 'exited':
      return 'degraded';
    case 'starting':
    case 'idle':
    case 'stopping':
    case 'stopped':
    case undefined:
      return 'idle';
  }
}

function toIpcError(error: SafeOperationalError): IpcError {
  const code = (IPC_ERROR_CODES as readonly string[]).includes(error.code)
    ? (error.code as IpcErrorCode)
    : 'unknown';

  return { code, message: error.message };
}
