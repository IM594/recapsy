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

test("store: upsertChunk + FTS search", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  const inserted = store.upsertChunk({
    startTs: Date.now() - 1000,
    endTs: Date.now(),
    app: "DemoApp",
    windowTitle: "Hello",
    text: "hello world from recapsense",
  });

  const results = store.searchChunks({ query: "hello", limit: 10 });
  assert.ok(results.length >= 1);
  assert.equal(results[0].id, inserted.id);
});

test("store: ingestFrame + compaction creates chunks", async () => {
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

  const { createdChunks, consumedFrames } = store.compactFramesToChunks();
  assert.equal(createdChunks, 1);
  assert.equal(consumedFrames, 2);

  const results = store.searchChunks({ query: "Second", limit: 10 });
  assert.equal(results.length, 1);
  assert.match(results[0].snippet ?? "", /Second/i);
});

test("store: ensureDailySummary generates text summary", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const dateStr = `${year}-${month}-${day}`;

  store.upsertChunk({
    startTs: Date.now() - 5_000,
    endTs: Date.now() - 1_000,
    app: "Notes",
    windowTitle: "Journal",
    text: "Wrote some notes for the daily summary test.",
  });

  const summary = store.ensureDailySummary(dateStr);
  assert.ok(summary);
  assert.equal(summary.date, dateStr);
  assert.match(summary.summary, /每日总结/);
});

test("store: settings read + patch", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  const initial = store.getSettings();
  assert.equal(initial.collector.intervalSeconds, 5);
  assert.equal(initial.collector.dedupeThreshold, 2);
  assert.equal(initial.collector.thumbnailEnabled, true);
  assert.equal(initial.agent.evidenceRetentionDays, 30);

  const updated = store.patchSettings({
    collector: {
      intervalSeconds: 3,
      dedupeThreshold: 1,
      thumbnailEnabled: false,
    },
    agent: {
      evidenceRetentionDays: 7,
    },
  });

  assert.equal(updated.collector.intervalSeconds, 3);
  assert.equal(updated.collector.dedupeThreshold, 1);
  assert.equal(updated.collector.thumbnailEnabled, false);
  assert.equal(updated.agent.evidenceRetentionDays, 7);

  assert.throws(
    () => store.patchSettings({ collector: { intervalSeconds: 0 } }),
    /intervalSeconds/
  );
});
