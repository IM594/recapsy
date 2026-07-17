import { describe, expect, it } from 'bun:test';
import { createOcrOperationKey } from '../ocr-operation';

describe('OCR operation identity', () => {
  const identity = {
    captureId: 'capture_1',
    mimeType: 'image/webp',
    sourceAssetHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    workspaceId: 'workspace_1',
  };

  it('is stable across retry attempts for the same capture asset', () => {
    expect(createOcrOperationKey(identity)).toBe(createOcrOperationKey({ ...identity }));
  });

  it('changes when the capture, workspace, asset hash, or MIME contract changes', () => {
    const key = createOcrOperationKey(identity);
    expect(createOcrOperationKey({ ...identity, captureId: 'capture_2' })).not.toBe(key);
    expect(createOcrOperationKey({ ...identity, workspaceId: 'workspace_2' })).not.toBe(key);
    expect(
      createOcrOperationKey({
        ...identity,
        sourceAssetHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }),
    ).not.toBe(key);
    expect(createOcrOperationKey({ ...identity, mimeType: 'image/png' })).not.toBe(key);
  });
});
