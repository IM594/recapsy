import { describe, expect, it } from 'bun:test';
import { AssetLocationSchema } from '../index.js';

const now = '2026-07-06T00:00:00.000Z';
const ids = {
  workspace: '22222222-2222-4222-8222-222222222222',
  asset: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  location: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};

describe('asset location contracts', () => {
  it('rejects local_device absolute path leakage fields', () => {
    expect(
      AssetLocationSchema.safeParse({
        id: ids.location,
        workspaceId: ids.workspace,
        assetId: ids.asset,
        kind: 'local_device',
        deviceId: 'macbook-pro-01',
        localDeviceAssetRef: 'local-asset-original-01',
        contentHash: 'sha256:original-hash',
        availability: 'available',
        isAuthoritative: true,
        createdAt: now,
        updatedAt: now,
        localUri: 'file:///Users/example/Pictures/capture.png',
      }).success,
    ).toBe(false);
  });

  it('rejects retired server temporary locations', () => {
    expect(
      AssetLocationSchema.safeParse({
        id: ids.location,
        workspaceId: ids.workspace,
        assetId: ids.asset,
        kind: 'server_temporary',
        temporaryUploadId: 'temporary-upload-01',
        createdAt: now,
        updatedAt: now,
      }).success,
    ).toBe(false);
  });
});
