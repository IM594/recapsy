import { test } from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../src/store.mjs";

function withEnv(nextEnv, fn) {
  const previous = {};
  for (const key of Object.keys(nextEnv)) {
    previous[key] = process.env[key];
    process.env[key] = nextEnv[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(nextEnv)) {
        if (previous[key] == null) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
    });
}

function makeStatement({ all, get, run } = {}) {
  return {
    all: all ?? (() => []),
    get: get ?? (() => null),
    run: run ?? (() => ({ changes: 0 })),
  };
}

function makeFakeDb({
  masterSql,
  masterSqlError,
  probeError,
  ftsSearchAll,
  prepareThrows,
  likeResults,
} = {}) {
  return {
    prepare(sql) {
      const text = String(sql);

      if (text.includes("FROM sqlite_master") && text.includes("name='chunks_fts'")) {
        if (masterSqlError) throw masterSqlError;
        return makeStatement({
          get: () => ({ sql: masterSql }),
        });
      }

      if (text.trim() === "SELECT 1 FROM chunks_fts LIMIT 1") {
        return makeStatement({
          get: () => {
            if (probeError) throw probeError;
            return { ok: 1 };
          },
        });
      }

      if (prepareThrows) {
        const maybeError = prepareThrows(text);
        if (maybeError) throw maybeError;
      }

      if (text.includes("FROM chunks_fts") && text.includes("MATCH")) {
        return makeStatement({
          all: ftsSearchAll ?? (() => []),
        });
      }

      if (text.includes("FROM chunks") && text.includes("LIKE")) {
        return makeStatement({
          all: () => likeResults ?? [],
        });
      }

      return makeStatement();
    },
  };
}

const passthroughTransaction = (_db, fn) => fn();

test("store: chunks_fts exists but module missing -> falls back to LIKE", async () => {
  await withEnv({ RECAPSENSE_DISABLE_FTS: "" }, async () => {
    const likeResults = [
      { id: "c1", start_ts: 1, end_ts: 2, app: "DemoApp", window_title: "t", score: null, snippet: "hello" },
    ];
    const db = makeFakeDb({
      masterSql: "CREATE VIRTUAL TABLE chunks_fts USING fts5(text, app, window_title, chunk_id UNINDEXED);",
      probeError: new Error("no such module: fts5"),
      likeResults,
    });

    const store = createStore(db, { withTransaction: passthroughTransaction });
    const rows = store.searchChunks({ query: "hello", limit: 10, scope: "all", app: "" });
    assert.equal(rows[0]?.id, "c1");
  });
});

test("store: FTS syntax error -> falls back to LIKE", async () => {
  await withEnv({ RECAPSENSE_DISABLE_FTS: "" }, async () => {
    const likeResults = [
      { id: "c2", start_ts: 1, end_ts: 2, app: "DemoApp", window_title: "t", score: null, snippet: "fallback" },
    ];
    const db = makeFakeDb({
      masterSql: "CREATE VIRTUAL TABLE chunks_fts USING fts5(text, app, window_title, chunk_id UNINDEXED);",
      ftsSearchAll: () => {
        throw new Error("fts5: syntax error near \"(\"");
      },
      likeResults,
    });

    const store = createStore(db, { withTransaction: passthroughTransaction });
    const rows = store.searchChunks({ query: "hello", limit: 10, scope: "all", app: "" });
    assert.equal(rows[0]?.id, "c2");
  });
});

test("store: safePrepareFts disables fts when prepare throws no such table", async () => {
  await withEnv({ RECAPSENSE_DISABLE_FTS: "" }, async () => {
    const likeResults = [
      { id: "c3", start_ts: 1, end_ts: 2, app: "DemoApp", window_title: "t", score: null, snippet: "like" },
    ];
    const db = makeFakeDb({
      masterSql: "CREATE VIRTUAL TABLE chunks_fts USING fts5(text, app, window_title, chunk_id UNINDEXED);",
      prepareThrows: (sql) => {
        if (sql.includes("DELETE FROM chunks_fts")) {
          return new Error("no such table: chunks_fts");
        }
        return null;
      },
      likeResults,
    });

    const store = createStore(db, { withTransaction: passthroughTransaction });
    const rows = store.searchChunks({ query: "hello", limit: 10, scope: "all", app: "" });
    assert.equal(rows[0]?.id, "c3");
  });
});

test("store: chunks_fts exists but is not fts -> falls back to LIKE", async () => {
  await withEnv({ RECAPSENSE_DISABLE_FTS: "" }, async () => {
    const db = makeFakeDb({
      masterSql: "CREATE TABLE chunks_fts(x TEXT);",
      likeResults: [{ id: "c4", start_ts: 1, end_ts: 2, app: "A", window_title: "", score: null, snippet: "x" }],
    });

    const store = createStore(db, { withTransaction: passthroughTransaction });
    const rows = store.searchChunks({ query: "hello", limit: 10, scope: "all", app: "" });
    assert.equal(rows[0]?.id, "c4");
  });
});

test("store: chunks_fts probe ignores sqlite_master errors and falls back", async () => {
  await withEnv({ RECAPSENSE_DISABLE_FTS: "" }, async () => {
    const db = makeFakeDb({
      masterSqlError: new Error("sqlite_master boom"),
      likeResults: [{ id: "c5", start_ts: 1, end_ts: 2, app: "A", window_title: "", score: null, snippet: "x" }],
    });

    const store = createStore(db, { withTransaction: passthroughTransaction });
    const rows = store.searchChunks({ query: "hello", limit: 10, scope: "all", app: "" });
    assert.equal(rows[0]?.id, "c5");
  });
});

test("store: fts4 mode builds fts4 search statements", async () => {
  await withEnv({ RECAPSENSE_DISABLE_FTS: "" }, async () => {
    const db = makeFakeDb({
      masterSql: "CREATE VIRTUAL TABLE chunks_fts USING fts4(text, app, window_title, chunk_id);",
      likeResults: [],
      ftsSearchAll: () => [],
    });

    const store = createStore(db, { withTransaction: passthroughTransaction });
    const rows = store.searchChunks({ query: "hello", limit: 10, scope: "all", app: "" });
    assert.ok(Array.isArray(rows));
  });
});

test("store: fts5 bm25 statement prepare failure disables FTS (searchChunksFtsStmt=null)", async () => {
  await withEnv({ RECAPSENSE_DISABLE_FTS: "" }, async () => {
    const db = makeFakeDb({
      masterSql: "CREATE VIRTUAL TABLE chunks_fts USING fts5(text, app, window_title, chunk_id UNINDEXED);",
      prepareThrows: (sql) => {
        if (sql.includes("bm25(chunks_fts)") && !sql.includes("AND c.app")) {
          return new Error("fts5 prepare boom");
        }
        return null;
      },
      likeResults: [{ id: "c6", start_ts: 1, end_ts: 2, app: "A", window_title: "", score: null, snippet: "x" }],
    });

    const store = createStore(db, { withTransaction: passthroughTransaction });
    const rows = store.searchChunks({ query: "hello", limit: 10, scope: "all", app: "" });
    assert.equal(rows[0]?.id, "c6");
  });
});

test("store: fts5 by-app statement prepare failure returns null (searchChunksFtsByAppStmt=null)", async () => {
  await withEnv({ RECAPSENSE_DISABLE_FTS: "" }, async () => {
    const db = makeFakeDb({
      masterSql: "CREATE VIRTUAL TABLE chunks_fts USING fts5(text, app, window_title, chunk_id UNINDEXED);",
      prepareThrows: (sql) => {
        if (sql.includes("bm25(chunks_fts)") && sql.includes("AND c.app = ?")) {
          return new Error("fts5 prepare by-app boom");
        }
        return null;
      },
      likeResults: [{ id: "c7", start_ts: 1, end_ts: 2, app: "A", window_title: "", score: null, snippet: "x" }],
    });

    const store = createStore(db, { withTransaction: passthroughTransaction });
    const rows = store.searchChunks({ query: "hello", limit: 10, scope: "all", app: "A" });
    assert.equal(rows[0]?.id, "c7");
  });
});
