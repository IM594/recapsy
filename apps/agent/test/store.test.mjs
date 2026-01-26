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

test("store: searchChunks supports app filter + scope", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  const now = Date.now();

  const chromeChunk = store.upsertChunk({
    startTs: now - 10_000,
    endTs: now - 9000,
    app: "Google Chrome",
    windowTitle: "Notion - Google Chrome",
    text: "some unrelated text",
  });

  const slackChunk = store.upsertChunk({
    startTs: now - 8000,
    endTs: now - 7000,
    app: "Slack",
    windowTitle: "hproj-bot (Channel) - Slack",
    text: "Sidebar shows Notion Folder in workspace",
  });

  // 1) scope=meta：只匹配 app/window_title，不应该因为正文里出现 Notion 就把 Slack 拉进来。
  const metaResults = store.searchChunks({ query: "notion", scope: "meta", limit: 20 });
  const metaIds = new Set(metaResults.map((r) => r.id));
  assert.ok(metaIds.has(chromeChunk.id));
  assert.ok(!metaIds.has(slackChunk.id));

  // 2) scope=text：只匹配正文；Chrome 的 windowTitle 里有 Notion，但 text 没有，应该被排除。
  const textResults = store.searchChunks({ query: "notion", scope: "text", limit: 20 });
  const textIds = new Set(textResults.map((r) => r.id));
  assert.ok(!textIds.has(chromeChunk.id));
  assert.ok(textIds.has(slackChunk.id));

  // 3) app 过滤：限制只看某个 app（大小写不敏感）。
  const chromeOnly = store.searchChunks({
    query: "notion",
    scope: "all",
    app: "google chrome",
    limit: 20,
  });
  assert.ok(chromeOnly.length >= 1);
  assert.equal(chromeOnly[0].app, "Google Chrome");

  // 4) query 为空时也支持 app 过滤（用于“只看某个 app 的最近 chunks”）。
  const recentChrome = store.searchChunks({ query: "", app: "Google Chrome", limit: 20 });
  assert.ok(recentChrome.length >= 1);
  assert.ok(recentChrome.every((r) => r.app === "Google Chrome"));
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
