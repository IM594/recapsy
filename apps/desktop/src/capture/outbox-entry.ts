import { createHash } from 'node:crypto';
import type { CaptureResultPayload, SafeCaptureContextPayload } from '../helper/index';
import { redactSensitiveString } from '../logging/redaction';
import type {
  CaptureOutboxEntryCreateInput,
  CaptureOutboxPayloadInput,
  CapturePrivacyDecision,
} from '../storage/index';

export type ProjectCaptureOutboxEntryInput = {
  payload: CaptureResultPayload;
  deviceId: string;
  workspaceId: string;
};

export function projectCaptureOutboxEntry({
  payload,
  deviceId,
  workspaceId,
}: ProjectCaptureOutboxEntryInput): CaptureOutboxEntryCreateInput {
  const [screenshot] = payload.assets;

  const capture = capturePayloadFromResult(payload);
  const assetRefs = assetRefsFromResult(payload, workspaceId);

  return {
    assetRefs,
    assetRefId: screenshot.ref,
    capture,
    createdAt: payload.observedAt,
    deviceId,
    id: payload.captureId,
    idempotencyKey: `${workspaceId}:${payload.captureId}`,
    payloadHash: payloadHash({
      assetRefId: screenshot.ref,
      assetRefs,
      capture,
      workspaceId,
    }),
    workspaceId,
  };
}

function assetRefsFromResult(payload: CaptureResultPayload, workspaceId: string) {
  return payload.assets.flatMap((asset) => {
    return [
      {
        assetRefId: asset.ref,
        availabilityState: 'available' as const,
        cleanupState: 'retained' as const,
        contentAddress: asset.hash,
        createdAt: payload.observedAt,
        hash: asset.hash,
        localAccessKey: safeLocalAccessKey(asset.ref, payload.captureId),
        mimeType: asset.mimeType,
        role: 'capture_original' as const,
        sizeBytes: asset.sizeBytes,
        workspaceId,
      },
    ];
  });
}

function capturePayloadFromResult(payload: CaptureResultPayload): CaptureOutboxPayloadInput {
  return {
    appName: payload.context.app.name,
    bundleId: payload.context.app.bundleId,
    // `capturedAt` is the native layer's own presentation-time fact; fall
    // back to the tick scheduler's `observedAt` when the helper does not yet
    // report it (see `helper/protocol/types.ts`).
    capturedAt: payload.capturedAt ?? payload.observedAt,
    captureType: 'screen',
    ...(payload.context.contextFingerprint
      ? { contextFingerprint: payload.context.contextFingerprint }
      : {}),
    documentPathCandidate: documentPathCandidate(payload.context),
    localEventId: payload.captureId,
    observedAt: payload.observedAt,
    privacyDecision: privacyDecision(payload.context),
    urlCandidate: urlCandidate(payload.context),
    windowTitleCandidate: windowTitleCandidate(payload.context),
  };
}

function privacyDecision(context: SafeCaptureContextPayload): CapturePrivacyDecision {
  const action = context.policy.decision;
  return {
    action,
    decidedAt: context.observedAt,
    policyVersion: context.policy.version,
    reasons: action === 'allow' ? [] : [action],
  };
}

function windowTitleCandidate(
  context: SafeCaptureContextPayload,
): CaptureOutboxPayloadInput['windowTitleCandidate'] {
  if (!context.window) return undefined;
  if (context.policy.decision === 'redact_context') {
    return { kind: 'redacted', reason: 'policy_redacted' };
  }
  return { kind: 'safe', value: context.window.title };
}

function urlCandidate(
  context: SafeCaptureContextPayload,
): CaptureOutboxPayloadInput['urlCandidate'] {
  if (!context.website) return undefined;
  if (context.policy.decision === 'redact_context') {
    return { kind: 'redacted', reason: 'policy_redacted' };
  }
  return {
    domain: context.website.host,
    kind: 'safe',
    normalized: context.website.origin,
  };
}

function documentPathCandidate(
  context: SafeCaptureContextPayload,
): CaptureOutboxPayloadInput['documentPathCandidate'] {
  if (!context.document) return undefined;
  if (context.policy.decision === 'redact_context') {
    return { kind: 'redacted', reason: 'policy_redacted' };
  }
  return { displayName: context.document.name, kind: 'safe' };
}

function safeLocalAccessKey(value: string, captureId: string): string {
  if (value.startsWith('/') || value.startsWith('file://') || /^[A-Za-z]:[\\/]/.test(value)) {
    return `opaque:asset:${captureId}`;
  }

  return redactSensitiveString(value);
}

function payloadHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
