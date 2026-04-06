import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { setupTestDb, cleanTestDb, teardownTestDb } from "../../helpers/test-db";
import { createEntityRepo } from "../../../src/storage/repositories/entity-repo";
import { createTestEntity } from "../../helpers/factories";
import pino from "pino";
import type { Surreal } from "surrealdb";

describe("EntityRepo", () => {
  let db: Surreal;
  let repo: ReturnType<typeof createEntityRepo>;

  beforeAll(async () => {
    db = await setupTestDb();
    repo = createEntityRepo({ db, logger: pino({ level: "silent" }) });
  });

  beforeEach(async () => {
    await cleanTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  test("create and findById", async () => {
    const input = createTestEntity({ type: "person", name: "Alice" });
    const created = await repo.create(input);
    expect(created.id).toBeDefined();
    expect(created.type).toBe("person");
    expect(created.name).toBe("Alice");
    expect(created.frequency).toBe(0);

    const found = await repo.findById(created.id);
    expect(found.name).toBe("Alice");
  });

  test("findByTypeName", async () => {
    await repo.create(createTestEntity({ type: "app", name: "VSCode" }));

    const found = await repo.findByTypeName("app", "VSCode");
    expect(found).toBeDefined();
    expect(found!.name).toBe("VSCode");

    const notFound = await repo.findByTypeName("app", "NonExistent");
    expect(notFound).toBeUndefined();
  });

  test("upsert creates new entity", async () => {
    const input = createTestEntity({ type: "topic", name: "TypeScript" });
    const entity = await repo.upsert(input);
    expect(entity.name).toBe("TypeScript");
    expect(entity.frequency).toBe(0);
  });

  test("upsert updates existing entity", async () => {
    const input = createTestEntity({ type: "topic", name: "Rust" });
    const first = await repo.upsert(input);
    expect(first.frequency).toBe(0);

    const second = await repo.upsert({ ...input, last_seen: new Date() });
    expect(second.frequency).toBe(1);
    expect(second.id).toBe(first.id);
  });

  test("count", async () => {
    expect(await repo.count()).toBe(0);
    await repo.create(createTestEntity());
    expect(await repo.count()).toBe(1);
  });
});
