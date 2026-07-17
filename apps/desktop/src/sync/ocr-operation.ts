import { createHash } from 'node:crypto';

export type OcrOperationIdentity = {
  workspaceId: string;
  captureId: string;
  sourceAssetHash: string;
  mimeType: string;
};

/** A stable proxy/provider operation identity. It intentionally excludes HTTP
 * request IDs and retry attempts so network recovery cannot purchase another
 * OCR run for the same captured asset. */
export function createOcrOperationKey(identity: OcrOperationIdentity): string {
  const canonical = [
    'recapsy-ocr-v1',
    identity.workspaceId,
    identity.captureId,
    identity.sourceAssetHash,
    identity.mimeType,
  ].join('\u0000');
  return `ocr:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}
