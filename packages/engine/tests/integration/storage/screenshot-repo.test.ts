import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { setupTestDb, cleanTestDb, teardownTestDb } from "../../helpers/test-db";
import { createScreenshotRepo } from "../../../src/storage/repositories/screenshot-repo";
import { createTestScreenshot } from "../../helpers/factories";
import pino from "pino";
import type { Surreal } from "surrealdb";

describe("ScreenshotRepo", () => {
  let db: Surreal;
  let repo: ReturnType<typeof createScreenshotRepo>;

  beforeAll(async () => {
    db = await setupTestDb();
    repo = createScreenshotRepo({ db, logger: pino({ level: "silent" }) });
  });

  beforeEach(async () => {
    await cleanTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  test("create and findById", async () => {
    const input = createTestScreenshot();
    const created = await repo.create(input);
    expect(created.id).toBeDefined();
    expect(created.app_name).toBe("Visual Studio Code");
    expect(created.status).toBe("queued");

    const found = await repo.findById(created.id);
    expect(found.capture_id).toBe(input.capture_id);
  });

  test("findByTimeRange", async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 3600_000);
    const future = new Date(now.getTime() + 3600_000);

    await repo.create(createTestScreenshot({ timestamp: now }));
    await repo.create(createTestScreenshot({ timestamp: past }));

    const results = await repo.findByTimeRange(
      new Date(past.getTime() - 1000),
      new Date(now.getTime() + 1000),
    );
    expect(results.length).toBe(2);

    // Should not include far future
    const emptyResults = await repo.findByTimeRange(future, new Date(future.getTime() + 1000));
    expect(emptyResults.length).toBe(0);
  });

  test("findByApp", async () => {
    await repo.create(createTestScreenshot({ bundle_id: "com.apple.Safari" }));
    await repo.create(createTestScreenshot({ bundle_id: "com.apple.Safari" }));
    await repo.create(createTestScreenshot({ bundle_id: "com.microsoft.VSCode" }));

    const results = await repo.findByApp("com.apple.Safari");
    expect(results.length).toBe(2);
  });

  test("findByCaptureId returns undefined for missing", async () => {
    const result = await repo.findByCaptureId("non-existent");
    expect(result).toBeUndefined();
  });

  test("findByCaptureId returns match", async () => {
    const input = createTestScreenshot({ capture_id: "unique-cap-123" });
    await repo.create(input);

    const found = await repo.findByCaptureId("unique-cap-123");
    expect(found).toBeDefined();
    expect(found!.capture_id).toBe("unique-cap-123");
  });

  test("updateStatus", async () => {
    const created = await repo.create(createTestScreenshot());
    await repo.updateStatus(created.id, "processing");

    const updated = await repo.findById(created.id);
    expect(updated.status).toBe("processing");
  });

  test("count", async () => {
    expect(await repo.count()).toBe(0);
    await repo.create(createTestScreenshot());
    await repo.create(createTestScreenshot());
    expect(await repo.count()).toBe(2);
  });
});
