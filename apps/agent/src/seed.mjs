import { resolveDataDir } from "./paths.mjs";
import { loadOrCreateApiToken } from "./secrets.mjs";
import { openDatabase } from "./db.mjs";
import { createStore } from "./store.mjs";

async function main() {
  const dataDir = resolveDataDir();
  await loadOrCreateApiToken(dataDir);
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  const now = Date.now();
  const chunks = [
    {
      startTs: now - 60_000,
      endTs: now - 55_000,
      app: "Google Chrome",
      windowTitle: "Demo – RecapSense",
      text: "这是一条 demo chunk，用于验证 FTS 搜索与 MCP 集成是否跑通。这里包含关键词：demo。",
    },
    {
      startTs: now - 30_000,
      endTs: now - 25_000,
      app: "Slack",
      windowTitle: "recapsense",
      text: "讨论了 MCP server 设计与本机 HTTP API。并确认了日总结默认自动生成。",
    },
  ];

  const inserted = chunks.map((chunk) => store.upsertChunk(chunk).id);
  console.log(`[seed] inserted ${inserted.length} chunks`);
  for (const id of inserted) {
    console.log(`[seed] chunk: ${id}`);
  }
}

main().catch((error) => {
  console.error("[seed] fatal:", error);
  process.exitCode = 1;
});
