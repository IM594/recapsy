import type { CaptureResultPayload, SafeCaptureContextPayload } from './protocol/types';

export type UnsafeCaptureContextInput = {
  appName?: string;
  bundleId?: string;
  windowTitle?: string;
  url?: string;
  documentPath?: string;
  axText?: string;
  providerToken?: string;
  cloudToken?: string;
};

export type CaptureProjectionInput = {
  captureId: string;
  assetRef: string;
  manifestRef: string;
  hash: string;
  mimeType: string;
  sizeBytes: number;
  observedAt: string;
  unsafeContext?: UnsafeCaptureContextInput;
};

export function createSafeCaptureResultPayload(
  input: CaptureProjectionInput,
): CaptureResultPayload {
  const manifest = {
    role: 'manifest' as const,
    ref: toOpaqueRef(input.manifestRef, 'manifest', input.captureId),
    hash: input.hash,
    mimeType: 'application/json',
    sizeBytes: 0,
  };
  const asset = {
    role: 'screenshot' as const,
    ref: toOpaqueRef(input.assetRef, 'asset', input.captureId),
    hash: input.hash,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
  };

  return {
    captureId: input.captureId,
    observedAt: input.observedAt,
    manifest,
    assets: [asset],
    context: createSafeContext(input),
  };
}

function createSafeContext(input: CaptureProjectionInput): SafeCaptureContextPayload {
  const context: SafeCaptureContextPayload = {
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

  if (unsafe.appName && unsafe.bundleId) {
    context.app = {
      name: unsafe.appName,
      bundleId: unsafe.bundleId,
    };
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

function toOpaqueRef(ref: string, prefix: 'asset' | 'manifest', captureId: string): string {
  if (!isLocalAbsolutePath(ref) && !ref.startsWith('file://')) {
    return ref;
  }

  return `opaque:${prefix}:${captureId}`;
}

function isLocalAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}
