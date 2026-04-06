/**
 * PoC-06: Bun + SurrealDB SDK 绑定方式确认
 * 通过标准: 确认在 Bun 下使用 WASM/N-API/HTTP 哪种模式最稳定
 * 失败预案: 使用纯 HTTP 连接模式
 */
import { Surreal, Table } from "surrealdb";

const ENDPOINT_WS = "ws://127.0.0.1:21890";
const ENDPOINT_HTTP = "http://127.0.0.1:21890";
const NS = "poc";
const DB = "test06";

async function testConnection(
  label: string,
  endpoint: string,
): Promise<{ pass: boolean; latency: number; error?: string }> {
  const db = new Surreal();
  try {
    const start = performance.now();
    await db.connect(endpoint);
    await db.signin({ username: "root", password: "root" });
    await db.use({ namespace: NS, database: DB });

    // 用 query 代替 create（避免 SCHEMAFULL table 限制）
    // SurrealDB 3.x: DELETE 不存在的表会抛 NotFoundError，用 REMOVE TABLE IF EXISTS 清理
    await db.query("REMOVE TABLE IF EXISTS test_conn");
    await db.query(
      "CREATE test_conn SET label = $label, ts = $ts",
      { label, ts: Date.now() },
    );
    const result = await db.query("SELECT * FROM test_conn");
    const all = (result as any)[0] ?? [];
    await db.query("REMOVE TABLE IF EXISTS test_conn");

    const latency = performance.now() - start;
    await db.close();

    return {
      pass: Array.isArray(all) && all.length > 0,
      latency,
    };
  } catch (e: any) {
    try {
      await db.close();
    } catch {}
    return { pass: false, latency: 0, error: String(e).slice(0, 200) };
  }
}

async function testEmbedded(): Promise<{
  pass: boolean;
  error?: string;
}> {
  try {
    // 动态导入 @surrealdb/node
    const { createNodeEngines } = await import("@surrealdb/node");
    const db = new Surreal({ engines: createNodeEngines() });

    await db.connect("mem://");
    await db.use({ namespace: NS, database: DB });

    await db
      .create(new Table("test_emb"))
      .content({ label: "embedded", timestamp: Date.now() });
    const all = await db.select(new Table("test_emb"));

    await db.close();
    return { pass: Array.isArray(all) && all.length > 0 };
  } catch (e: any) {
    return { pass: false, error: String(e).slice(0, 300) };
  }
}

async function testEmbeddedPersist(): Promise<{
  pass: boolean;
  error?: string;
}> {
  try {
    const { createNodeEngines } = await import("@surrealdb/node");
    const db = new Surreal({ engines: createNodeEngines() });

    await db.connect("surrealkv:///tmp/recaply-poc06-embedded");
    await db.use({ namespace: NS, database: DB });

    await db
      .create(new Table("test_emb_p"))
      .content({ label: "embedded persist", timestamp: Date.now() });
    const all = await db.select(new Table("test_emb_p"));

    await db.close();
    return { pass: Array.isArray(all) && all.length > 0 };
  } catch (e: any) {
    return { pass: false, error: String(e).slice(0, 300) };
  }
}

async function main() {
  console.log("=== PoC-06: SDK 绑定方式对比 ===\n");
  console.log(`Bun: ${Bun.version}, Platform: ${process.platform}/${process.arch}\n`);

  // 1. WebSocket
  console.log("--- 1. WebSocket (ws://) ---");
  const ws = await testConnection("ws", ENDPOINT_WS);
  console.log(
    `  ${ws.pass ? "✅ PASS" : "❌ FAIL"} — 延迟 ${ws.latency.toFixed(0)}ms${ws.error ? ` — ${ws.error}` : ""}`,
  );

  // 2. HTTP
  console.log("\n--- 2. HTTP (http://) ---");
  const http = await testConnection("http", ENDPOINT_HTTP);
  console.log(
    `  ${http.pass ? "✅ PASS" : "❌ FAIL"} — 延迟 ${http.latency.toFixed(0)}ms${http.error ? ` — ${http.error}` : ""}`,
  );

  // 3. Embedded (mem://)
  console.log("\n--- 3. Embedded @surrealdb/node (mem://) ---");
  const mem = await testEmbedded();
  console.log(`  ${mem.pass ? "✅ PASS" : "❌ FAIL"}${mem.error ? ` — ${mem.error}` : ""}`);

  // 4. Embedded (surrealkv://)
  console.log("\n--- 4. Embedded @surrealdb/node (surrealkv://) ---");
  const kvp = await testEmbeddedPersist();
  console.log(`  ${kvp.pass ? "✅ PASS" : "❌ FAIL"}${kvp.error ? ` — ${kvp.error}` : ""}`);

  // 汇总
  console.log("\n=== PoC-06 结果汇总 ===");
  console.log(`  WebSocket (ws://):     ${ws.pass ? "✅" : "❌"}`);
  console.log(`  HTTP (http://):        ${http.pass ? "✅" : "❌"}`);
  console.log(`  Embedded (mem://):     ${mem.pass ? "✅" : "❌"}`);
  console.log(`  Embedded (surrealkv)   ${kvp.pass ? "✅" : "❌"}`);

  const bestMode = ws.pass
    ? "WebSocket (推荐，支持 live query)"
    : http.pass
      ? "HTTP (备选)"
      : "无可用远程连接模式";
  console.log(`\n推荐模式: ${bestMode}`);
  console.log(`Embedded 可用: ${mem.pass || kvp.pass ? "是" : "否（Bun 兼容性问题）"}`);
}

main().catch(console.error);
