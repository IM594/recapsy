import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Surreal } from "surrealdb";
import { createNodeEngines } from "@surrealdb/node";
import { createMigrationRunner } from "../../../src/storage/migrations/runner";
import { allMigrations } from "../../../src/storage/migrations";
import pino from "pino";

describe("MigrationRunner", () => {
  let db: Surreal;

  beforeAll(async () => {
    db = new Surreal({ engines: createNodeEngines() });
    await db.connect("mem://");
    await db.use({ namespace: "migration_test", database: "migration_test" });
  });

  afterAll(async () => {
    await db.close();
  });

  test("applies pending migrations", async () => {
    const runner = createMigrationRunner({
      db,
      logger: pino({ level: "silent" }),
      migrations: allMigrations,
    });

    await runner.run();

    const versions = await runner.getAppliedVersions();
    expect(versions).toContain(1);
  });

  test("is idempotent — running twice does not fail", async () => {
    const runner = createMigrationRunner({
      db,
      logger: pino({ level: "silent" }),
      migrations: allMigrations,
    });

    // Should not throw on second run
    await runner.run();
    const versions = await runner.getAppliedVersions();
    expect(versions.length).toBe(1);
  });

  test("skips already applied versions", async () => {
    const runner = createMigrationRunner({
      db,
      logger: pino({ level: "silent" }),
      migrations: allMigrations,
    });

    const versions = await runner.getAppliedVersions();
    expect(versions).toContain(1);
  });
});
