import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { setupTestDb, cleanTestDb, teardownTestDb } from "../../helpers/test-db";
import { createActivitySegmentRepo } from "../../../src/storage/repositories/activity-segment-repo";
import { createTestActivitySegment } from "../../helpers/factories";
import pino from "pino";
import type { Surreal } from "surrealdb";

describe("ActivitySegmentRepo", () => {
  let db: Surreal;
  let repo: ReturnType<typeof createActivitySegmentRepo>;

  beforeAll(async () => {
    db = await setupTestDb();
    repo = createActivitySegmentRepo({ db, logger: pino({ level: "silent" }) });
  });

  beforeEach(async () => {
    await cleanTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  test("create and findById", async () => {
    const input = createTestActivitySegment();
    const created = await repo.create(input);
    expect(created.id).toBeDefined();
    expect(created.app_name).toBe("Visual Studio Code");
    expect(created.duration_seconds).toBe(300);

    const found = await repo.findById(created.id);
    expect(found.activity).toBe(input.activity);
    expect(found.scene_type).toBe("coding");
  });

  test("findByTimeRange", async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 3600_000);

    await repo.create(createTestActivitySegment({ session_start: now, session_end: new Date(now.getTime() + 300_000) }));
    await repo.create(createTestActivitySegment({ session_start: past, session_end: new Date(past.getTime() + 300_000) }));

    const results = await repo.findByTimeRange(
      new Date(past.getTime() - 1000),
      new Date(now.getTime() + 1000),
    );
    expect(results.length).toBe(2);

    // Should not include far future
    const future = new Date(now.getTime() + 7200_000);
    const emptyResults = await repo.findByTimeRange(future, new Date(future.getTime() + 1000));
    expect(emptyResults.length).toBe(0);
  });

  test("findById throws NotFoundError for missing", async () => {
    await expect(repo.findById("activity_segment:nonexistent")).rejects.toThrow("not found");
  });

  test("count", async () => {
    expect(await repo.count()).toBe(0);
    await repo.create(createTestActivitySegment());
    await repo.create(createTestActivitySegment());
    expect(await repo.count()).toBe(2);
  });

  test("create with optional tokenized fields", async () => {
    const input = createTestActivitySegment({
      activity_tokenized: "editing typescript files",
      summary_tokenized: "working on recaply engine",
    });
    const created = await repo.create(input);
    expect(created.id).toBeDefined();

    const found = await repo.findById(created.id);
    expect(found.activity_tokenized).toBe("editing typescript files");
    expect(found.summary_tokenized).toBe("working on recaply engine");
  });
});
