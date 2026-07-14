import type { AssetCacheRef, RendererSafeAssetRef } from './types';

export function toRendererSafeAssetRef(asset: AssetCacheRef): RendererSafeAssetRef {
  return {
    assetRefId: asset.assetRefId,
    availabilityCheckedAt: asset.availabilityCheckedAt,
    availabilitySafeError: asset.availabilitySafeError
      ? {
          code: asset.availabilitySafeError.code,
          retryable: asset.availabilitySafeError.retryable,
        }
      : undefined,
    availabilityState: asset.availabilityState,
    cleanupState: asset.cleanupState,
    createdAt: asset.createdAt,
    mimeType: asset.mimeType,
    role: asset.role,
    sizeBytes: asset.sizeBytes,
  };
}
