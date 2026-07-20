import type { OutboxJob, OutboxJobCreateInput, StoredOcrResult } from './types';

export function createPendingOutboxJob(job: OutboxJobCreateInput): OutboxJob {
  return {
    assetRefId: job.assetRefId,
    attempt: 0,
    capture: normalizeCapturePayload(job),
    createdAt: job.createdAt,
    deviceId: job.deviceId,
    id: job.id,
    idempotencyKey: job.idempotencyKey,
    payloadHash: job.payloadHash,
    state: 'pending',
    updatedAt: job.createdAt,
    workspaceId: job.workspaceId,
    ...(job.nextRetryAt ? { nextRetryAt: job.nextRetryAt } : {}),
  };
}

export function normalizeCapturePayload(job: OutboxJobCreateInput): OutboxJob['capture'] {
  return {
    appName: job.capture?.appName ?? 'Recapsy Desktop',
    capturedAt: job.capture?.capturedAt ?? job.createdAt,
    captureType: job.capture?.captureType ?? 'screen',
    observedAt: job.capture?.observedAt ?? job.createdAt,
    privacyDecision: {
      action: job.capture?.privacyDecision?.action ?? 'allow',
      decidedAt:
        job.capture?.privacyDecision?.decidedAt ??
        job.capture?.observedAt ??
        job.capture?.capturedAt ??
        job.createdAt,
      policyVersion: job.capture?.privacyDecision?.policyVersion ?? 'desktop-default',
      reasons: [...(job.capture?.privacyDecision?.reasons ?? [])],
    },
    ...(job.capture?.bundleId ? { bundleId: job.capture.bundleId } : {}),
    ...(job.capture?.contextConfidence ? { contextConfidence: job.capture.contextConfidence } : {}),
    ...(job.capture?.contextFingerprint
      ? { contextFingerprint: job.capture.contextFingerprint }
      : {}),
    ...(job.capture?.documentPathCandidate
      ? { documentPathCandidate: { ...job.capture.documentPathCandidate } }
      : {}),
    ...(job.capture?.localEventId ? { localEventId: job.capture.localEventId } : {}),
    ...(job.capture?.metadata ? { metadata: { ...job.capture.metadata } } : {}),
    ...(job.capture?.urlCandidate ? { urlCandidate: { ...job.capture.urlCandidate } } : {}),
    ...(job.capture?.userId ? { userId: job.capture.userId } : {}),
    ...(job.capture?.windowTitleCandidate
      ? { windowTitleCandidate: { ...job.capture.windowTitleCandidate } }
      : {}),
  };
}

export function cloneOutboxJob(job: OutboxJob): OutboxJob {
  return {
    ...job,
    capture: cloneCapturePayload(job.capture),
    ...(job.lastSafeError ? { lastSafeError: { ...job.lastSafeError } } : {}),
    ...(job.ocrResult ? { ocrResult: cloneStoredOcrResult(job.ocrResult) } : {}),
  };
}

export function outboxJobMatchesInput(existing: OutboxJob, input: OutboxJobCreateInput): boolean {
  return (
    existing.assetRefId === input.assetRefId &&
    existing.payloadHash === input.payloadHash &&
    JSON.stringify(cloneCapturePayload(existing.capture)) ===
      JSON.stringify(cloneCapturePayload(normalizeCapturePayload(input)))
  );
}

export function cloneCapturePayload(capture: OutboxJob['capture']): OutboxJob['capture'] {
  return {
    ...capture,
    privacyDecision: {
      ...capture.privacyDecision,
      reasons: [...capture.privacyDecision.reasons],
    },
    ...(capture.documentPathCandidate
      ? { documentPathCandidate: { ...capture.documentPathCandidate } }
      : {}),
    ...(capture.metadata ? { metadata: { ...capture.metadata } } : {}),
    ...(capture.urlCandidate ? { urlCandidate: { ...capture.urlCandidate } } : {}),
    ...(capture.windowTitleCandidate
      ? { windowTitleCandidate: { ...capture.windowTitleCandidate } }
      : {}),
  };
}

export function cloneStoredOcrResult(result: StoredOcrResult): StoredOcrResult {
  return structuredClone(result);
}

export function capturePayloadMatches(
  left: OutboxJob['capture'],
  right: OutboxJob['capture'],
): boolean {
  return JSON.stringify(cloneCapturePayload(left)) === JSON.stringify(cloneCapturePayload(right));
}

export function requiresLocalAssetBytes(job: OutboxJob): boolean {
  if (job.ocrResult) {
    return false;
  }

  if (
    job.capture.privacyDecision.action === 'block_capture' ||
    job.capture.privacyDecision.action === 'block_ocr'
  ) {
    return false;
  }

  return job.state === 'pending' || job.state === 'syncing';
}
