import { test } from "node:test";
import assert from "node:assert/strict";

import { migrate } from "../src/db.mjs";

function makeFakeDb({ userVersion = 0, onExec } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      if (String(sql).trim() === "PRAGMA user_version;") {
        return { get: () => ({ user_version: userVersion }) };
      }
      throw new Error(`unexpected prepare: ${sql}`);
    },
    exec(sql) {
      calls.push(String(sql));
      onExec?.(String(sql));
    },
  };
}

test("db: migrate rolls back on error (and rethrows original error)", async () => {
  const db = makeFakeDb({
    userVersion: 0,
    onExec: (sql) => {
      if (sql === "BEGIN IMMEDIATE" || sql === "COMMIT" || sql === "ROLLBACK") return;
      if (sql.startsWith("PRAGMA user_version")) return;
      throw new Error("migration boom");
    },
  });

  await assert.rejects(() => migrate(db), /migration boom/);
  assert.ok(db.calls.includes("BEGIN IMMEDIATE"));
  assert.ok(db.calls.includes("ROLLBACK"));
});

test("db: migrate ignores rollback errors and keeps original error", async () => {
  const db = makeFakeDb({
    userVersion: 0,
    onExec: (sql) => {
      if (sql === "BEGIN IMMEDIATE") return;
      if (sql === "ROLLBACK") {
        throw new Error("rollback boom");
      }
      if (sql.startsWith("PRAGMA user_version")) return;
      if (sql === "COMMIT") return;
      throw new Error("migration boom");
    },
  });

  await assert.rejects(() => migrate(db), /migration boom/);
  assert.ok(db.calls.includes("ROLLBACK"));
});

