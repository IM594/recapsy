import type { CaptureResultPayload, SafeCaptureContextPayload } from './protocol/types';
import { isSafeCaptureId } from './protocol/validation';

export type UnsafeCaptureContextInput = {
  windowTitle?: string;
  url?: string;
  documentPath?: string;
  axText?: string;
  providerToken?: string;
  cloudToken?: string;
};

export type CaptureResultInput = {
  application: { name: string; bundleId: string };
  captureId: string;
  hash: string;
  sizeBytes: number;
  observedAt: string;
  unsafeContext?: UnsafeCaptureContextInput;
};

export function createSafeCaptureResultPayload(input: CaptureResultInput): CaptureResultPayload {
  if (!isSafeCaptureId(input.captureId)) {
    throw new Error('Capture result capture id is invalid.');
  }

  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new Error('Capture result size must be a positive integer.');
  }

  const asset = {
    role: 'screenshot' as const,
    ref: `${input.captureId}/screenshot.webp`,
    hash: input.hash,
    mimeType: 'image/webp',
    sizeBytes: input.sizeBytes,
  };

  return {
    captureId: input.captureId,
    observedAt: input.observedAt,
    assets: [asset],
    context: createSafeContext(input),
  };
}

function createSafeContext(input: CaptureResultInput): SafeCaptureContextPayload {
  const context: SafeCaptureContextPayload = {
    app: { ...input.application },
    observedAt: input.observedAt,
    policy: {
      version: 'mock-policy',
      decision: 'allow',
    },
  };
  const unsafe = input.unsafeContext;

  if (!unsafe) {
    return context;
  }

  if (unsafe.windowTitle) {
    context.window = {
      title: unsafe.windowTitle,
    };
  }

  const website = safeWebsite(unsafe.url);
  if (website) {
    context.website = website;
  }

  const documentName = safeDocumentName(unsafe.documentPath);
  if (documentName) {
    context.document = {
      name: documentName,
    };
  }

  return context;
}

function safeWebsite(rawUrl: string | undefined): SafeCaptureContextPayload['website'] | undefined {
  if (!rawUrl) {
    return undefined;
  }

  try {
    const url = new URL(rawUrl);

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return undefined;
    }

    return {
      origin: url.origin,
      host: url.host,
    };
  } catch {
    return undefined;
  }
}

function safeDocumentName(path: string | undefined): string | undefined {
  if (!path) {
    return undefined;
  }

  const parts = path.split(/[\\/]/);
  const name = parts.at(-1);

  return name && name.length > 0 ? name : undefined;
}
