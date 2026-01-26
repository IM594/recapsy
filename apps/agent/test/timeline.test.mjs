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

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

test("timeline: normalizes window title suffix and counters", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  const today = new Date();
  const date = formatLocalDate(today);
  const baseTs = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
    9,
    0,
    0,
    0
  ).getTime();

  store.ingestFrame({
    ts: baseTs,
    app: "Google Chrome",
    windowTitle: "Notion - Google Chrome",
    ocrText: "frame 1",
  });

  store.ingestFrame({
    ts: baseTs + 5000,
    app: "Google Chrome",
    windowTitle: "Notion (2) - Google Chrome",
    ocrText: "frame 2",
  });

  const timeline = store.getDailyTimeline({
    date,
    splitGapMs: 90_000,
    sessionMergeGapMs: 5 * 60_000,
  });

  assert.equal(timeline.date, date);
  assert.ok(timeline.spans.length >= 1);

  // 两条 frame 的 windowTitle 虽然不同，但规范化后应落在同一 span。
  const chromeSpans = timeline.spans.filter((s) => s.app === "Google Chrome");
  assert.equal(chromeSpans.length, 1);
  assert.equal(chromeSpans[0].window_title_norm, "Notion");
});

test("timeline: merges same app spans into sessions within merge gap", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  const today = new Date();
  const date = formatLocalDate(today);
  const baseTs = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
    10,
    0,
    0,
    0
  ).getTime();

  // Slack span #1
  store.ingestFrame({
    ts: baseTs,
    app: "Slack",
    windowTitle: "general - Slack",
    ocrText: "slack 1",
  });

  // 中间切到 Chrome（模拟来回切换）
  store.ingestFrame({
    ts: baseTs + 5000,
    app: "Google Chrome",
    windowTitle: "Docs - Google Chrome",
    ocrText: "chrome",
  });

  // Slack span #2（与 #1 的间隔 2min，<= 5min merge gap，应合并到同一 session）
  store.ingestFrame({
    ts: baseTs + 2 * 60_000,
    app: "Slack",
    windowTitle: "general - Slack",
    ocrText: "slack 2",
  });

  const timeline = store.getDailyTimeline({
    date,
    splitGapMs: 90_000,
    sessionMergeGapMs: 5 * 60_000,
  });

  const slackSessions = timeline.sessions.filter((s) => s.app === "Slack");
  assert.equal(slackSessions.length, 1);
  assert.ok(slackSessions[0].span_count >= 2);
});

