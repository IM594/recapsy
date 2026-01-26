import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openDatabase } from "../src/db.mjs";
import { createStore } from "../src/store.mjs";
import { createDatabaseSnapshot } from "../src/backup.mjs";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "recapsense-test-"));
}

test("backup: createDatabaseSnapshot exports a readable sqlite db", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  const baseTs = Date.now() - 60_000;
  store.ingestFrame({
    ts: baseTs,
    app: "Chrome",
    windowTitle: "Example",
    ocrText: "First frame text",
    phash: "abc",
  });

  store.ingestFrame({
    ts: baseTs + 5000,
    app: "Chrome",
    windowTitle: "Example",
    ocrText: "Second frame text",
    phash: "def",
  });

  store.compactFramesToChunks();

  const snapshotPath = await createDatabaseSnapshot({ db, dataDir });
  const stat = await fs.stat(snapshotPath);
  assert.ok(stat.size > 0);

  const snapshotDb = new DatabaseSync(snapshotPath);
  const framesCount = snapshotDb.prepare("SELECT COUNT(*) as n FROM frames;").get()
    ?.n;
  const chunksCount = snapshotDb.prepare("SELECT COUNT(*) as n FROM chunks;").get()
    ?.n;
  assert.ok(Number(framesCount) >= 2);
  assert.ok(Number(chunksCount) >= 1);

  if (typeof snapshotDb.close === "function") snapshotDb.close();
  if (typeof db.close === "function") db.close();
});

