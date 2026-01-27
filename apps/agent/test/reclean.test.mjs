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

test("store: recleanChunks dryRun reports updates but does not mutate", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  const now = Date.now();
  const inserted = store.upsertChunk({
    startTs: now - 2000,
    endTs: now - 1000,
    app: "Chrome",
    windowTitle: "Example",
    text: [
      "File",
      "Edit",
      "View",
      "Window",
      "Help",
      "Hello world from reclean test",
    ].join("\n"),
  });

  const before = store.getChunk(inserted.id);
  assert.ok(before);
  assert.match(before.text, /File/);

  const report = store.recleanChunks({ limit: 10, dryRun: true });
  assert.ok(report.processed >= 1);
  assert.ok(report.updated >= 1);
  assert.equal(report.dryRun, true);

  const after = store.getChunk(inserted.id);
  assert.ok(after);
  // dryRun 不应修改 text
  assert.equal(after.text, before.text);

  if (typeof db.close === "function") db.close();
});

test("store: recleanChunks rewrites text when not dryRun", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  const now = Date.now();
  const inserted = store.upsertChunk({
    startTs: now - 2000,
    endTs: now - 1000,
    app: "Chrome",
    windowTitle: "Example",
    text: [
      "File",
      "Edit",
      "View",
      "Window",
      "Help",
      "Hello world from reclean test",
    ].join("\n"),
  });

  const before = store.getChunk(inserted.id);
  assert.ok(before);

  const report = store.recleanChunks({ limit: 10, dryRun: false });
  assert.ok(report.processed >= 1);
  assert.ok(report.updated >= 1);
  assert.equal(report.dryRun, false);

  const after = store.getChunk(inserted.id);
  assert.ok(after);
  assert.notEqual(after.text, before.text);
  assert.doesNotMatch(after.text, /File\\b/);
  assert.match(after.text, /Hello world/);

  if (typeof db.close === "function") db.close();
});

