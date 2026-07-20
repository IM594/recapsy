export function parseJson<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new StorageCorruptionError();
  }
}

class StorageCorruptionError extends Error {
  readonly code = 'storage_corruption';

  constructor() {
    super('Local operational store contains invalid JSON.');
  }
}
