import type { AssetCacheRef, RendererSafeAssetRef } from './types';

export function toRendererSafeAssetRef(asset: AssetCacheRef): RendererSafeAssetRef {
  return {
    assetRefId: asset.assetRefId,
    cleanupState: asset.cleanupState,
    createdAt: asset.createdAt,
    hash: asset.hash,
    mimeType: asset.mimeType,
    role: asset.role,
    sizeBytes: asset.sizeBytes,
  };
}
