import { describe, expect, test } from "bun:test";
import {
  AppError,
  ConfigError,
  StorageError,
  NotFoundError,
  ValidationError,
  MigrationError,
} from "../../../src/utils/errors";

describe("errors", () => {
  test("AppError has code and message", () => {
    const err = new AppError("TEST", "test message");
    expect(err.code).toBe("TEST");
    expect(err.message).toBe("test message");
    expect(err.name).toBe("AppError");
    expect(err).toBeInstanceOf(Error);
  });

  test("AppError preserves cause", () => {
    const cause = new Error("original");
    const err = new AppError("TEST", "wrapped", cause);
    expect(err.cause).toBe(cause);
  });

  test("ConfigError extends AppError", () => {
    const err = new ConfigError("bad config");
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("CONFIG_ERROR");
    expect(err.name).toBe("ConfigError");
  });

  test("StorageError extends AppError", () => {
    const err = new StorageError("db down");
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("STORAGE_ERROR");
  });

  test("NotFoundError has resource info", () => {
    const err = new NotFoundError("screenshot", "abc123");
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toContain("screenshot");
    expect(err.message).toContain("abc123");
  });

  test("ValidationError extends AppError", () => {
    const err = new ValidationError("invalid input");
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("VALIDATION_ERROR");
  });

  test("MigrationError extends AppError", () => {
    const err = new MigrationError("migration 1 failed");
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("MIGRATION_ERROR");
  });
});
