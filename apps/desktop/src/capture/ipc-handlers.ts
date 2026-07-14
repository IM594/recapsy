import type { CaptureHelperState } from '../helper/public';
import {
  type CaptureEventSummaryDto,
  type CaptureStatusDto,
  IPC_ERROR_CODES,
  type IpcError,
  type IpcErrorCode,
  type IpcHandlerMap,
  createRendererSafeSuccess,
} from '../ipc/public';
import type { DesktopRuntime } from '../runtime/public';
import type {
  OperationalStoreRepository,
  OutboxJob,
  SafeOperationalError,
} from '../storage/public';
import type { CaptureHelperEventIntake } from './capture-helper-event-intake';

export type CaptureIpcHandlerOptions = {
  eventIntake: CaptureHelperEventIntake;
  runtime: DesktopRuntime;
  store: OperationalStoreRepository;
  workspaceId: string;
};

export function createCaptureIpcHandlers(options: CaptureIpcHandlerOptions): IpcHandlerMap {
  return {
    'capture.getStatus': async () => createRendererSafeSuccess(buildCaptureStatusDto(options)),
    'capture.getRecentEvents': async (payload) =>
      createRendererSafeSuccess(await buildRecentEventsDto(options, payload as { limit?: number })),
    'capture.pause': async () => {
      await options.runtime.pause();
      return createRendererSafeSuccess(buildCaptureStatusDto(options));
    },
    'capture.resume': async () => {
      await options.runtime.resume();
      return createRendererSafeSuccess(buildCaptureStatusDto(options));
    },
  };
}

function buildCaptureStatusDto(options: CaptureIpcHandlerOptions): CaptureStatusDto {
  const snapshot = options.runtime.getSnapshot();
  const helperStatus = snapshot.captureHelper;
  const intakeStatus = options.eventIntake.getStatus();
  const permissions = intakeStatus.permissions ?? {
    accessibility: 'unknown',
    screenRecording: 'unknown',
  };
  const lastSafeError = helperStatus?.lastSafeError ?? intakeStatus.lastSafeError;

  return {
    paused: snapshot.status === 'paused',
    permissions,
    recentEventCount: 0,
    state: toCaptureStatusState(helperStatus?.state),
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
