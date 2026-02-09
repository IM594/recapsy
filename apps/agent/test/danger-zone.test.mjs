import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { openDatabase } from "../src/db.mjs";
import { createStore } from "../src/store.mjs";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "recapsense-test-"));
}

test("store: deleteDangerZone range deletes overlapping chunk + frames and returns filePaths", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  const baseTs = Date.now() - 60_000;
  const day = "2000-01-01";

  // 两条 frame 会被压实进一个 chunk（带媒体路径，用于验证 filePaths）
  store.ingestFrame({
    ts: baseTs,
    app: "Chrome",
    windowTitle: "Example",
    ocrText: "First frame text",
    phash: "abc",
    screenshotPath: `media/screenshots/${day}/chunked_1.webp`,
  });
  store.ingestFrame({
    ts: baseTs + 5000,
    app: "Chrome",
    windowTitle: "Example",
    ocrText: "Second frame text",
    phash: "def",
    screenshotPath: `media/screenshots/${day}/chunked_2.webp`,
  });
  store.compactFramesToChunks();

  // 一个未压实 frame（也在范围内）
  store.ingestFrame({
    ts: baseTs + 10_000,
    app: "Chrome",
    windowTitle: "Example",
    ocrText: "Unchunked frame text",
    phash: "ghi",
    screenshotPath: `media/screenshots/${day}/unchunked.webp`,
  });

  const beforeFrames = db.prepare("SELECT COUNT(1) AS c FROM frames").get().c;
  const beforeChunks = db.prepare("SELECT COUNT(1) AS c FROM chunks").get().c;
  assert.equal(beforeFrames, 3);
  assert.equal(beforeChunks, 1);

  const result = store.deleteDangerZone({
    scope: "range",
    startTs: baseTs - 1000,
    endTs: baseTs + 30_000,
    maxChunkIdsPerBatch: 50,
    maxFramesPerBatch: 50,
  });

  assert.equal(result.scope, "range");
  assert.equal(result.deletedChunks, 1);
  assert.equal(result.deletedFrames, 3);
  assert.ok(Array.isArray(result.filePaths));
  assert.ok(result.filePaths.includes(`media/screenshots/${day}/chunked_1.webp`));
  assert.ok(result.filePaths.includes(`media/screenshots/${day}/chunked_2.webp`));
  assert.ok(result.filePaths.includes(`media/screenshots/${day}/unchunked.webp`));

  const afterFrames = db.prepare("SELECT COUNT(1) AS c FROM frames").get().c;
  const afterChunks = db.prepare("SELECT COUNT(1) AS c FROM chunks").get().c;
  assert.equal(afterFrames, 0);
  assert.equal(afterChunks, 0);

  if (typeof db.close === "function") db.close();
});

test("store: deleteDangerZone validates scope and range params", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  assert.throws(() => store.deleteDangerZone({ scope: "bad" }), /scope must be/);
  assert.throws(
    () => store.deleteDangerZone({ scope: "range" }),
    (error) => error instanceof Error && error.message.includes("startTs/endTs")
  );
  assert.throws(
    () => store.deleteDangerZone({ scope: "range", startTs: 2, endTs: 1 }),
    /endTs/
  );

  if (typeof db.close === "function") db.close();
});

test("store: deleteDangerZone scope=all clears tables (filePaths empty)", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  const now = Date.now();
  store.upsertChunk({
    startTs: now - 2000,
    endTs: now - 1000,
    app: "Demo",
    windowTitle: "Hello",
    text: "demo text",
  });
  store.ingestFrame({
    ts: now - 1500,
    app: "Demo",
    windowTitle: "Hello",
    ocrText: "demo frame",
    phash: "x",
    screenshotPath: "media/screenshots/2000-01-01/a.webp",
  });

  const beforeFrames = db.prepare("SELECT COUNT(1) AS c FROM frames").get().c;
  const beforeChunks = db.prepare("SELECT COUNT(1) AS c FROM chunks").get().c;
  assert.ok(beforeFrames >= 1);
  assert.ok(beforeChunks >= 1);

  const result = store.deleteDangerZone({ scope: "all" });
  assert.equal(result.scope, "all");
  assert.equal(result.deletedChunks, 0);
  assert.equal(result.deletedFrames, 0);
  assert.deepEqual(result.filePaths, []);

  const afterFrames = db.prepare("SELECT COUNT(1) AS c FROM frames").get().c;
  const afterChunks = db.prepare("SELECT COUNT(1) AS c FROM chunks").get().c;
  assert.equal(afterFrames, 0);
  assert.equal(afterChunks, 0);

  if (typeof db.close === "function") db.close();
});
