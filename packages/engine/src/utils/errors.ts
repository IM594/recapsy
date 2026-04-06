export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ConfigError extends AppError {
  constructor(message: string, cause?: unknown) {
    super("CONFIG_ERROR", message, cause);
  }
}

export class StorageError extends AppError {
  constructor(message: string, cause?: unknown) {
    super("STORAGE_ERROR", message, cause);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super("NOT_FOUND", `${resource} '${id}' not found`);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, cause?: unknown) {
    super("VALIDATION_ERROR", message, cause);
  }
}

export class MigrationError extends AppError {
  constructor(message: string, cause?: unknown) {
    super("MIGRATION_ERROR", message, cause);
  }
}
