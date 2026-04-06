import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { setupTestDb, cleanTestDb, teardownTestDb } from "../../helpers/test-db";
import { createRelationshipRepo } from "../../../src/storage/repositories/relationship-repo";
import { createEntityRepo } from "../../../src/storage/repositories/entity-repo";
import { createTestEntity } from "../../helpers/factories";
import pino from "pino";
import type { Surreal } from "surrealdb";

describe("RelationshipRepo", () => {
  let db: Surreal;
  let relationshipRepo: ReturnType<typeof createRelationshipRepo>;
  let entityRepo: ReturnType<typeof createEntityRepo>;

  beforeAll(async () => {
    db = await setupTestDb();
    const logger = pino({ level: "silent" });
    relationshipRepo = createRelationshipRepo({ db, logger });
    entityRepo = createEntityRepo({ db, logger });
  });

  beforeEach(async () => {
    await cleanTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  async function createTwoEntities() {
    const e1 = await entityRepo.create(createTestEntity({ name: "Entity-A" }));
    const e2 = await entityRepo.create(createTestEntity({ name: "Entity-B" }));
    return { e1, e2 };
  }

  test("create relationship between entities", async () => {
    const { e1, e2 } = await createTwoEntities();
    const now = new Date();

    const rel = await relationshipRepo.create({
      inEntity: e1.id,
      outEntity: e2.id,
      relationType: "co_appeared",
      firstSeen: now,
      lastSeen: now,
    });

    expect(rel.id).toBeDefined();
    expect(rel.relation_type).toBe("co_appeared");
    expect(rel.weight).toBe(1.0);
    expect(rel.in).toBe(e1.id);
    expect(rel.out).toBe(e2.id);
  });

  test("findByEntities", async () => {
    const { e1, e2 } = await createTwoEntities();
    const now = new Date();

    await relationshipRepo.create({
      inEntity: e1.id,
      outEntity: e2.id,
      relationType: "co_appeared",
      firstSeen: now,
      lastSeen: now,
    });

    const results = await relationshipRepo.findByEntities(e1.id, e2.id);
    expect(results.length).toBe(1);
    expect(results[0].relation_type).toBe("co_appeared");

    // No results for reversed direction
    const reversed = await relationshipRepo.findByEntities(e2.id, e1.id);
    expect(reversed.length).toBe(0);
  });

  test("findByEntities with relationType filter", async () => {
    const { e1, e2 } = await createTwoEntities();
    const now = new Date();

    await relationshipRepo.create({
      inEntity: e1.id,
      outEntity: e2.id,
      relationType: "co_appeared",
      firstSeen: now,
      lastSeen: now,
    });

    const matched = await relationshipRepo.findByEntities(e1.id, e2.id, "co_appeared");
    expect(matched.length).toBe(1);

    const noMatch = await relationshipRepo.findByEntities(e1.id, e2.id, "mentioned");
    expect(noMatch.length).toBe(0);
  });

  test("count", async () => {
    expect(await relationshipRepo.count()).toBe(0);

    const { e1, e2 } = await createTwoEntities();
    const now = new Date();

    await relationshipRepo.create({
      inEntity: e1.id,
      outEntity: e2.id,
      relationType: "co_appeared",
      firstSeen: now,
      lastSeen: now,
    });

    expect(await relationshipRepo.count()).toBe(1);
  });

  test("create with custom weight", async () => {
    const { e1, e2 } = await createTwoEntities();
    const now = new Date();

    const rel = await relationshipRepo.create({
      inEntity: e1.id,
      outEntity: e2.id,
      relationType: "used_with",
      weight: 0.85,
      firstSeen: now,
      lastSeen: now,
    });

    expect(rel.weight).toBe(0.85);
  });
});
