import type { AssetCacheRef } from './types';

export function cloneAssetRef(asset: AssetCacheRef): AssetCacheRef {
  return {
    ...asset,
    ...(asset.availabilitySafeError
      ? { availabilitySafeError: { ...asset.availabilitySafeError } }
      : {}),
    ...(asset.cleanupSafeError ? { cleanupSafeError: { ...asset.cleanupSafeError } } : {}),
  };
}

export function assetRefMatches(left: AssetCacheRef, right: AssetCacheRef): boolean {
  return JSON.stringify(cloneAssetRef(left)) === JSON.stringify(cloneAssetRef(right));
}
