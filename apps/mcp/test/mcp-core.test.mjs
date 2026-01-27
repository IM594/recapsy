import assert from "node:assert/strict";
import test from "node:test";

import { toolList, formatDailyTimeline, formatSearchResults, formatChunk, formatDailySummary } from "../src/mcp-core.mjs";

test("toolList includes recapsense_get_daily_timeline", () => {
  const tools = toolList();
  assert.ok(Array.isArray(tools));
  assert.ok(tools.some((t) => t.name === "recapsense_get_daily_timeline"));
});

test("formatDailyTimeline overview", () => {
  const start = Date.parse("2026-01-26T00:00:00+08:00");
  const end = Date.parse("2026-01-27T00:00:00+08:00");

  const timeline = {
    date: "2026-01-26",
    start_ts: start,
    end_ts: end,
    split_gap_ms: 90_000,
    session_merge_gap_ms: 300_000,
    apps: [
      {
        app: "Chrome",
        active_ms: 3_600_000,
        frame_count: 120,
        span_count: 12,
        session_count: 3,
        first_ts: Date.parse("2026-01-26T08:00:00+08:00"),
        last_ts: Date.parse("2026-01-26T23:59:00+08:00"),
      },
    ],
    sessions: [],
    spans: [],
  };

  const text = formatDailyTimeline(timeline, { date: "2026-01-26", view: "overview" });
  assert.match(text, /时间轴：2026-01-26/);
  assert.match(text, /App 用时 Top/);
  assert.match(text, /Chrome/);
  assert.match(text, /活跃 1小时/);
});

test("formatDailyTimeline sessions with app filter", () => {
  const start = Date.parse("2026-01-26T00:00:00+08:00");
  const end = Date.parse("2026-01-27T00:00:00+08:00");

  const timeline = {
    date: "2026-01-26",
    start_ts: start,
    end_ts: end,
    split_gap_ms: 90_000,
    session_merge_gap_ms: 300_000,
    apps: [],
    sessions: [
      {
        id: "session-chrome-1",
        start_ts: Date.parse("2026-01-26T09:00:00+08:00"),
        end_ts: Date.parse("2026-01-26T10:00:00+08:00"),
        active_ms: 1_800_000,
        app: "Chrome",
        span_count: 5,
        titles: ["GitHub", "Issues"],
      },
      {
        id: "session-terminal-1",
        start_ts: Date.parse("2026-01-26T10:10:00+08:00"),
        end_ts: Date.parse("2026-01-26T10:20:00+08:00"),
        active_ms: 600_000,
        app: "Terminal",
        span_count: 2,
        titles: ["zsh"],
      },
    ],
    spans: [],
  };

  const text = formatDailyTimeline(timeline, {
    date: "2026-01-26",
    view: "sessions",
    app: "Chrome",
    limit: 50,
  });

  assert.match(text, /会话 sessions/);
  assert.match(text, /过滤：app=Chrome/);
  assert.match(text, /09:00:00 ~ 10:00:00/);
  assert.match(text, /活跃 30分/);
  assert.match(text, /Chrome/);
  assert.doesNotMatch(text, /Terminal/);
});

test("formatDailyTimeline raw returns JSON", () => {
  const timeline = { date: "2026-01-26", apps: [], sessions: [], spans: [] };
  const text = formatDailyTimeline(timeline, { view: "raw" });
  assert.match(text, /"date": "2026-01-26"/);
});

test("formatDailyTimeline limit normalizes to integer range", () => {
  const timeline = {
    date: "2026-01-26",
    apps: [
      { app: "A", active_ms: 60_000, frame_count: 1, span_count: 1, session_count: 1 },
      { app: "B", active_ms: 60_000, frame_count: 1, span_count: 1, session_count: 1 },
      { app: "C", active_ms: 60_000, frame_count: 1, span_count: 1, session_count: 1 },
    ],
    sessions: [],
    spans: [],
  };

  const text = formatDailyTimeline(timeline, { view: "overview", limit: "2" });
  assert.match(text, /App 用时 Top 2/);
});

test("formatSearchResults empty", () => {
  assert.equal(formatSearchResults([]), "没有找到结果。");
});

test("formatSearchResults includes id, app and snippet", () => {
  const results = [
    {
      id: "chunk-1",
      start_ts: Date.parse("2026-01-26T09:00:00+08:00"),
      app: "Chrome",
      window_title: "Example",
      snippet: "Hello    world\nfrom   RecapSense",
    },
  ];
  const text = formatSearchResults(results);
  assert.match(text, /Chrome/);
  assert.match(text, /id: chunk-1/);
  assert.match(text, /Hello world from RecapSense/);
});

test("formatChunk null and non-empty", () => {
  assert.equal(formatChunk(null), "未找到该 chunk。");

  const chunk = {
    id: "chunk-1",
    start_ts: Date.parse("2026-01-26T09:00:00+08:00"),
    end_ts: Date.parse("2026-01-26T09:10:00+08:00"),
    app: "Chrome",
    window_title: "Example",
    text: "some text",
  };
  const text = formatChunk(chunk);
  assert.match(text, /id: chunk-1/);
  assert.match(text, /some text/);
});

test("formatDailySummary null and non-empty", () => {
  assert.match(formatDailySummary(null, "2026-01-26"), /暂无日总结/);

  const summary = {
    date: "2026-01-26",
    start_ts: Date.parse("2026-01-26T00:00:00+08:00"),
    end_ts: Date.parse("2026-01-27T00:00:00+08:00"),
    summary: "今天主要做了 A/B/C。",
  };
  const text = formatDailySummary(summary, "2026-01-26");
  assert.match(text, /日总结：2026-01-26/);
  assert.match(text, /今天主要做了/);
});
