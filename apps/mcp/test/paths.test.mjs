import assert from "node:assert/strict";
import test from "node:test";

import { resolveDataDir } from "../src/paths.mjs";

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

test("mcp paths: resolveDataDir uses env when set", async () => {
  await withEnv({ RECAPSENSE_DATA_DIR: "/tmp/recapsense-data-dir-test" }, async () => {
    assert.equal(resolveDataDir(), "/tmp/recapsense-data-dir-test");
  });
});

test("mcp paths: resolveDataDir defaults to .recapsense in cwd", async () => {
  await withEnv({ RECAPSENSE_DATA_DIR: "" }, async () => {
    assert.ok(resolveDataDir().endsWith("/.recapsense"));
  });
});
