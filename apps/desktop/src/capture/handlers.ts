import type { LocalCapturePolicyRuleKind } from '@recapsy/contracts';
import type { CaptureHelperState } from '../helper/index';
import {
  type CaptureStatusDto,
  IPC_ERROR_CODES,
  type IpcError,
  type IpcErrorCode,
  type IpcHandlerMap,
  type LocalCapturePolicyRulesDto,
  createRendererSafeSuccess,
} from '../ipc/index';
import type { SafeOperationalError } from '../storage/index';
import type { CaptureControl } from './control';
import type { CapturePolicyController } from './policy';
import type { CaptureHistoryReader } from './store';

export type CaptureIpcHandlerOptions = {
  control: CaptureControl;
  policy: CapturePolicyController;
  store: CaptureHistoryReader;
  workspaceId: string;
};

export function createCaptureIpcHandlers(options: CaptureIpcHandlerOptions): IpcHandlerMap {
  return {
    'capture.getStatus': async () =>
      createRendererSafeSuccess(await buildCaptureStatusDto(options)),
    'capture.pause': async () => {
      await options.control.pause();
      return createRendererSafeSuccess(await buildCaptureStatusDto(options));
    },
    'capture.resume': async () => {
      await options.control.resume();
      return createRendererSafeSuccess(await buildCaptureStatusDto(options));
    },
    'capture.listLocalRules': async () =>
      createRendererSafeSuccess(await buildLocalRulesDto(options.policy)),
    'capture.blockBundle': async (payload: unknown) => {
      await options.policy.blockBundle((payload as { bundleId: string }).bundleId);
      return createRendererSafeSuccess(await buildLocalRulesDto(options.policy));
    },
    'capture.addLocalRule': async (payload: unknown) => {
      const input = payload as { kind: LocalCapturePolicyRuleKind; pattern: string };
      await options.policy.addLocalRule(input);
      return createRendererSafeSuccess(await buildLocalRulesDto(options.policy));
    },
    'capture.removeLocalRule': async (payload: unknown) => {
      await options.policy.removeLocalRule((payload as { ruleId: string }).ruleId);
      return createRendererSafeSuccess(await buildLocalRulesDto(options.policy));
    },
  };
}

async function buildLocalRulesDto(
  policy: CapturePolicyController,
): Promise<LocalCapturePolicyRulesDto> {
  return {
    rules: (await policy.listLocalRules()).map((rule) => ({
      enabled: rule.enabled,
      id: rule.id,
      kind: rule.kind,
      pattern: rule.pattern,
    })),
  };
}

async function buildCaptureStatusDto(options: CaptureIpcHandlerOptions): Promise<CaptureStatusDto> {
  const snapshot = options.control.getSnapshot();
  const helperStatus = snapshot.captureHelper;
  const pauseReason = snapshot.pauseReasons?.[0];
  const recentEvents = await options.store.listOutboxJobs({ workspaceId: options.workspaceId });

  return {
    admission: {
      active: snapshot.admission.reasons.length > 0,
      reasons: [...snapshot.admission.reasons],
    },
    paused: snapshot.status === 'paused',
    ...(pauseReason ? { pauseReason } : {}),
    permissions: snapshot.permissions,
    recentEventCount: recentEvents.length,
    state: toCaptureStatusState(helperStatus?.state),
    ...(helperStatus?.policyHash && helperStatus.policyVersion
      ? {
          policy: {
            hash: helperStatus.policyHash,
            version: helperStatus.policyVersion,
          },
        }
      : {}),
    ...(snapshot.lastSafeError ? { lastError: toIpcError(snapshot.lastSafeError) } : {}),
  };
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
