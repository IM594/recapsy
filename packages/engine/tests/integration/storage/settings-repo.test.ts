import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { setupTestDb, cleanTestDb, teardownTestDb } from "../../helpers/test-db";
import { createSettingsRepo } from "../../../src/storage/repositories/settings-repo";
import pino from "pino";
import type { Surreal } from "surrealdb";

describe("SettingsRepo", () => {
  let db: Surreal;
  let repo: ReturnType<typeof createSettingsRepo>;

  beforeAll(async () => {
    db = await setupTestDb();
    repo = createSettingsRepo({ db, logger: pino({ level: "silent" }) });
  });

  beforeEach(async () => {
    await cleanTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  test("get returns undefined for missing key", async () => {
    const value = await repo.get("non_existent");
    expect(value).toBeUndefined();
  });

  test("set and get", async () => {
    await repo.set("theme", "dark");
    const value = await repo.get("theme");
    expect(value).toBe("dark");
  });

  test("set overwrites existing value (upsert)", async () => {
    await repo.set("theme", "dark");
    await repo.set("theme", "light");
    const value = await repo.get("theme");
    expect(value).toBe("light");
  });

  test("set supports complex values", async () => {
    const complex = { enabled: true, options: [1, 2, 3] };
    await repo.set("features", complex);
    const value = await repo.get("features");
    expect(value).toEqual(complex);
  });

  test("getAll returns all settings", async () => {
    await repo.set("key1", "value1");
    await repo.set("key2", "value2");
    const all = await repo.getAll();
    expect(all.length).toBe(2);
  });

  test("delete removes setting", async () => {
    await repo.set("to_delete", "bye");
    expect(await repo.get("to_delete")).toBe("bye");

    await repo.delete("to_delete");
    expect(await repo.get("to_delete")).toBeUndefined();
  });
});
