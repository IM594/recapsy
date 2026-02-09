import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { openDatabase } from "../src/db.mjs";
import { createStore } from "../src/store.mjs";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "recapsense-store-branches-"));
}

test("store: getSettings falls back to defaults when settings table missing", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  db.exec("DROP TABLE settings;");
  const settings = store.getSettings();
  assert.equal(settings.collector.intervalSeconds, 5);
  assert.equal(settings.agent.evidenceRetentionDays, 365);

  if (typeof db.close === "function") db.close();
});

test("store: getSettings parses known keys and ignores invalid JSON/unknown keys", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  const now = Date.now();
  const upsert = db.prepare(
    "INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at"
  );

  upsert.run("collector.intervalSeconds", "3", now);
  upsert.run("collector.ocrLevel", "\"accurate\"", now);
  upsert.run("collector.ocrLanguages", JSON.stringify(["en", " ", "", "zh-Hans"]), now);
  upsert.run("collector.excludedApps", JSON.stringify(["com.b", "com.a", "com.a", "not a bundle id"]), now);
  upsert.run("unknown.key", "\"x\"", now);
  upsert.run("collector.dedupeThreshold", "{", now); // invalid json -> ignored

  const settings = store.getSettings();
  assert.equal(settings.collector.intervalSeconds, 3);
  assert.equal(settings.collector.ocrLevel, "accurate");
  assert.deepEqual(settings.collector.ocrLanguages, ["en", "zh-Hans"]);
  // invalid bundle id 应在 dedupeBundleIds 时被过滤掉
  assert.deepEqual(settings.collector.excludedApps, ["com.a", "com.b"]);

  if (typeof db.close === "function") db.close();
});

test("store: patchSettings validates input and supports no-op patch", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  assert.throws(() => store.patchSettings(null), /must be an object/);
  assert.throws(
    () => store.patchSettings({ collector: { dedupeThreshold: -1 } }),
    /dedupeThreshold/
  );
  assert.throws(
    () => store.patchSettings({ collector: { ocrLevel: "bad" } }),
    /ocrLevel/
  );
  assert.throws(
    () => store.patchSettings({ collector: { excludedApps: ["not bundle id"] } }),
    /Bundle ID/
  );
  assert.throws(
    () => store.patchSettings({ collector: { excludedApps: "com.example.app" } }),
    /excludedApps must be an array/
  );
  assert.throws(
    () => store.patchSettings({
      collector: {
        excludedApps: Array.from({ length: 201 }, (_x, i) => `com.example.app${i}`),
      },
    }),
    /excludedApps is too large/
  );
  assert.throws(
    () => store.patchSettings({ collector: { ocrLanguages: [] } }),
    /must not be empty/
  );
  assert.throws(
    () => store.patchSettings({ agent: { evidenceRetentionDays: 0 } }),
    /evidenceRetentionDays/
  );
  assert.throws(
    () => store.patchSettings({ agent: { evidenceCleanupIntervalMinutes: 0 } }),
    /evidenceCleanupIntervalMinutes/
  );
  assert.throws(
    () => store.patchSettings({ agent: { mediaWarnThresholdBytes: 0 } }),
    /mediaWarnThresholdBytes/
  );
  assert.throws(
    () => store.patchSettings({ agent: { mediaWarnThresholdBytes: Number.MAX_SAFE_INTEGER + 1 } }),
    /too large/
  );

  // no-op patch：返回当前 settings（updates.length===0）
  const before = store.getSettings();
  const after = store.patchSettings({ collector: {}, agent: {} });
  assert.deepEqual(after, before);

  if (typeof db.close === "function") db.close();
});

test("store: ingestFrame validates ocrText and enforces excluded bundle id", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  assert.throws(() => store.ingestFrame({ app: "A" }), /ocrText is required/);

  store.patchSettings({ collector: { excludedApps: ["com.example.secret"] } });
  const skipped = store.ingestFrame({
    ts: Date.now(),
    app: "Secret",
    appBundleId: "com.example.secret",
    windowTitle: "Secret",
    ocrText: "x",
  });
  assert.equal(skipped.skipped, true);

  // not excluded -> should insert
  const inserted = store.ingestFrame({
    ts: Date.now(),
    app: "Ok",
    appBundleId: "com.example.ok",
    windowTitle: "Ok",
    ocrText: "hello",
  });
  assert.ok(inserted.id);

  if (typeof db.close === "function") db.close();
});

test("store: upsertChunk validates empty text", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  assert.throws(() => store.upsertChunk({ text: "" }), /chunk\.text is required/);

  if (typeof db.close === "function") db.close();
});

test("store: searchChunks handles empty query and meta/text scopes", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  const now = Date.now();
  store.upsertChunk({
    startTs: now - 2000,
    endTs: now - 1000,
    app: "Chrome",
    windowTitle: "Notion - Chrome",
    text: "正文 mention Slack",
  });
  store.upsertChunk({
    startTs: now - 4000,
    endTs: now - 3000,
    app: "Slack",
    windowTitle: "general - Slack",
    text: "正文 mention Notion",
  });

  // empty query -> recent list
  const recent = store.searchChunks({ query: "", limit: 2 });
  assert.ok(recent.length >= 1);

  // meta scope -> only app/windowTitle
  const meta = store.searchChunks({ query: "notion", scope: "meta", limit: 10 });
  assert.ok(meta.some((r) => r.app === "Chrome"));

  // text scope -> only text like/fts
  const text = store.searchChunks({ query: "notion", scope: "text", limit: 10 });
  assert.ok(text.some((r) => r.app === "Slack"));

  if (typeof db.close === "function") db.close();
});

test("store: recleanChunks covers multiple low-signal heuristics", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  const now = Date.now();
  const inserted = store.upsertChunk({
    startTs: now - 2000,
    endTs: now - 1000,
    app: "Warp",
    windowTitle: "Example",
    text: [
      "File Edit View Window Help", // menu bar
      "Warp File", // AppName + menu token
      "SuperLongAppName123 File", // AppName File (长字符串) 的额外分支
      "%%%%", // symbol block
      "99+", // badge
      "12", // page number
      "Hello world", // keep
    ].join("\n"),
  });

  store.recleanChunks({ limit: 10, dryRun: false });
  const after = store.getChunk(inserted.id);
  assert.ok(after);
  assert.match(after.text, /Hello world/);
  assert.doesNotMatch(after.text, /Warp File/);
  assert.doesNotMatch(after.text, /99\\+/);

  if (typeof db.close === "function") db.close();
});

test("store: getDailyTimeline validates date and clamps params", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  assert.throws(() => store.getDailyTimeline({ date: "bad" }), /Invalid date/);
  assert.throws(() => store.getDailyTimeline({ date: "2020-aa-01" }), /Invalid date/);

  const date = "2000-01-01";
  const timeline = store.getDailyTimeline({
    date,
    splitGapMs: -1,
    sessionMergeGapMs: -1,
    maxChunkIdsPerSpan: 999999,
  });
  assert.equal(timeline.date, date);
  assert.ok(Array.isArray(timeline.apps));

  if (typeof db.close === "function") db.close();
});

test("store: compactFramesToChunks handles empty groups and frequent short lines filtering", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  const baseTs = Date.now() - 60_000;

  // 先来一组“全是低信号”的 frames：flush 时 cleanedPerFrame.length===0
  store.ingestFrame({
    ts: baseTs,
    app: "A",
    windowTitle: "W",
    ocrText: "File Edit View Window Help\n%%%%\n99+",
    phash: "p1",
  });
  store.ingestFrame({
    ts: baseTs + 1000,
    app: "A",
    windowTitle: "W",
    ocrText: "File Edit View Window Help\n%%%%\n99+",
    phash: "p2",
  });

  // 再来一组 >=4 帧：让“高频短行”被识别并移除，但仍保留正文
  for (let i = 0; i < 4; i += 1) {
    store.ingestFrame({
      ts: baseTs + 10_000 + i * 1000,
      app: "B",
      windowTitle: "W2",
      ocrText: `Project Alpha\nHello ${i}`,
      phash: `q${i}`,
    });
  }

  // 再来一组 >=4 帧：只有“高频短行”，会被过滤到 text 为空，flush 直接丢弃（1708 分支）
  for (let i = 0; i < 4; i += 1) {
    store.ingestFrame({
      ts: baseTs + 30_000 + i * 1000,
      app: "C",
      windowTitle: "W3",
      ocrText: "Project Alpha",
      phash: `z${i}`,
    });
  }

  const result = store.compactFramesToChunks({ maxGapMs: 15_000, maxFramesPerRun: 100 });
  assert.ok(result.consumedFrames >= 4);
  assert.ok(result.createdChunks >= 1);

  const results = store.searchChunks({ query: "Hello", limit: 10 });
  assert.ok(results.length >= 1);

  if (typeof db.close === "function") db.close();
});

test("store: expireChunkedFrameMedia validates cutoffTs", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  assert.throws(() => store.expireChunkedFrameMedia({ cutoffTs: "bad" }), /cutoffTs/);

  if (typeof db.close === "function") db.close();
});

test("store: recleanChunks reports empty and skippedEmpty cases", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  const empty = store.recleanChunks({ limit: 10, dryRun: true });
  assert.equal(empty.processed, 0);
  assert.equal(empty.updated, 0);

  store.upsertChunk({
    startTs: Date.now() - 2000,
    endTs: Date.now() - 1000,
    app: "X",
    windowTitle: "X",
    text: "File Edit View Window Help\n%%%%\n99+",
  });

  const report = store.recleanChunks({ limit: 10, dryRun: true });
  assert.ok(report.skippedEmpty >= 1);

  if (typeof db.close === "function") db.close();
});

test("store: ensureDailySummary returns existing summary when no chunks", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  const date = "2000-01-01";
  db.prepare(
    "INSERT INTO summaries_daily (date, start_ts, end_ts, summary, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, NULL)"
  ).run(date, 1, 2, "existing", Date.now(), Date.now());

  const summary = store.ensureDailySummary(date);
  assert.equal(summary.date, date);
  assert.match(summary.summary, /existing/);

  if (typeof db.close === "function") db.close();
});

test("store: getDailyTimeline includes chunk_ids in spans and splits sessions when gap too large", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  const date = "2000-01-01";
  const baseTs = new Date(2000, 0, 1, 9, 0, 0, 0).getTime();

  store.ingestFrame({ ts: baseTs, app: "Chrome", windowTitle: "Docs", ocrText: "Hello", phash: "a" });
  store.ingestFrame({ ts: baseTs + 5000, app: "Chrome", windowTitle: "Docs", ocrText: "Hello2", phash: "b" });
  store.compactFramesToChunks();

  // 6 分钟后再来一次：会切分为新的 session（gap>merge gap）
  store.ingestFrame({ ts: baseTs + 6 * 60_000, app: "Chrome", windowTitle: "Docs", ocrText: "Hello3", phash: "c" });
  store.ingestFrame({ ts: baseTs + 6 * 60_000 + 5000, app: "Chrome", windowTitle: "Docs", ocrText: "Hello4", phash: "d" });
  store.compactFramesToChunks();

  const timeline = store.getDailyTimeline({ date, sessionMergeGapMs: 5 * 60_000 });
  assert.ok(timeline.spans.some((s) => Array.isArray(s.chunk_ids) && s.chunk_ids.length >= 1));
  assert.ok(timeline.sessions.filter((s) => s.app === "Chrome").length >= 2);

  if (typeof db.close === "function") db.close();
});

test("store: deleteDangerZone covers lastHour/lastDay and tolerates missing tables", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  store.ingestFrame({ ts: Date.now() - 1000, app: "A", windowTitle: "W", ocrText: "x", phash: "a" });

  // 触发 lastHour/lastDay 参数分支（不关心删了多少）
  store.deleteDangerZone({ scope: "lastHour" });
  store.deleteDangerZone({ scope: "lastDay" });

  // 让 chunks_fts 删除语句失败，走 catch（1867-1868）
  db.exec("DROP TABLE IF EXISTS chunks_fts;");
  store.deleteDangerZone({ scope: "all" });

  // 让 summaries_daily 删除失败，走 catch（1931-1932）
  db.exec("DROP TABLE IF EXISTS summaries_daily;");
  store.deleteDangerZone({ scope: "range", startTs: 0, endTs: Date.now() + 1 });

  if (typeof db.close === "function") db.close();
});

test("store: getDailyTimeline uses today when date omitted", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  const timeline = store.getDailyTimeline();
  assert.ok(timeline);
  assert.ok(String(timeline.date).includes("-"));

  if (typeof db.close === "function") db.close();
});

test("store: upsertDailySummary validates numbers", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  assert.throws(
    () => store.upsertDailySummary({ date: "2000-01-01", startTs: "x", endTs: 1, summary: "ok" }),
    /startTs\/endTs must be numbers/
  );

  if (typeof db.close === "function") db.close();
});

test("store: compactFramesToChunks returns zeros when no frames", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  const result = store.compactFramesToChunks();
  assert.deepEqual(result, { createdChunks: 0, consumedFrames: 0 });

  if (typeof db.close === "function") db.close();
});

test("store: expireChunkedFrameMedia returns empty when no rows", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  const result = store.expireChunkedFrameMedia({ cutoffTs: Date.now() - 1, maxFramesPerRun: 10 });
  assert.equal(result.clearedFrames, 0);
  assert.deepEqual(result.filePaths, []);

  if (typeof db.close === "function") db.close();
});

test("store: searchChunks uses LIKE-by-app when FTS disabled", async () => {
  const prev = process.env.RECAPSENSE_DISABLE_FTS;
  process.env.RECAPSENSE_DISABLE_FTS = "1";
  try {
    const dataDir = await makeTempDir();
    const { db, withTransaction } = await openDatabase(dataDir);
    const store = createStore(db, { withTransaction });

    const now = Date.now();
    store.upsertChunk({
      startTs: now - 2000,
      endTs: now - 1000,
      app: "DemoApp",
      windowTitle: "Hello",
      text: "hello world",
    });

    const results = store.searchChunks({ query: "hello", limit: 10, scope: "all", app: "DemoApp" });
    assert.ok(results.some((r) => r.app === "DemoApp"));

    if (typeof db.close === "function") db.close();
  } finally {
    if (prev == null) delete process.env.RECAPSENSE_DISABLE_FTS;
    else process.env.RECAPSENSE_DISABLE_FTS = prev;
  }
});
