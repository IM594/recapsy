/**
 * PoC-10: embedded 模式启动方式和内存管理
 * 通过标准: SDK connect("mem://") 或 connect("surrealkv://") 正常工作，内存管理可控
 * 失败预案: 降级为 standalone server（launchd 额外管理一个进程）
 *
 * 注意: 此测试使用 @surrealdb/node N-API 绑定，在 Bun 下可能不稳定
 */
import { Surreal, Table, StringRecordId } from "surrealdb";

const NS = "poc";
const DB = "test10";

async function testMemoryMode(): Promise<{ pass: boolean; error?: string }> {
  try {
    const { createNodeEngines } = await import("@surrealdb/node");
    const db = new Surreal({ engines: createNodeEngines() });
    await db.connect("mem://");
    await db.use({ namespace: NS, database: DB });

    // 写入数据
    for (let i = 0; i < 100; i++) {
      await db.create(new StringRecordId(`mem_test:${i}`)).content({
        text: `内存模式测试 ${i}`,
        data: Array.from({ length: 100 }, () => Math.random()),
      });
    }

    const count = await db.query("SELECT count() FROM mem_test GROUP ALL");
    const n = (count as any)[0]?.[0]?.count ?? 0;

    await db.close();
    return { pass: n === 100 };
  } catch (e: any) {
    return { pass: false, error: String(e).slice(0, 300) };
  }
}

async function testSurrealKVMode(): Promise<{
  pass: boolean;
  error?: string;
}> {
  const path = "/tmp/recaply-poc10-kv";
  try {
    // 清理旧数据
    const proc = Bun.spawnSync(["rm", "-rf", path]);

    const { createNodeEngines } = await import("@surrealdb/node");
    const db = new Surreal({ engines: createNodeEngines() });
    await db.connect(`surrealkv://${path}`);
    await db.use({ namespace: NS, database: DB });

    for (let i = 0; i < 50; i++) {
      await db.create(new StringRecordId(`kv_test:${i}`)).content({
        text: `SurrealKV 测试 ${i}`,
      });
    }

    const count = await db.query("SELECT count() FROM kv_test GROUP ALL");
    const n = (count as any)[0]?.[0]?.count ?? 0;

    await db.close();
    return { pass: n === 50 };
  } catch (e: any) {
    return { pass: false, error: String(e).slice(0, 300) };
  }
}

async function testFileMode(): Promise<{ pass: boolean; error?: string }> {
  try {
    const { createNodeEngines } = await import("@surrealdb/node");
    const db = new Surreal({ engines: createNodeEngines() });
    await db.connect("file:///tmp/recaply-poc10-file");
    await db.use({ namespace: NS, database: DB });
    await db.close();
    return { pass: true };
  } catch (e: any) {
    return { pass: false, error: String(e).slice(0, 300) };
  }
}

async function main() {
  console.log("=== PoC-10: Embedded 模式启动方式测试 ===\n");
  console.log(
    `Bun: ${Bun.version}, Platform: ${process.platform}/${process.arch}\n`,
  );

  console.log("--- 1. mem:// 模式 ---");
  const mem = await testMemoryMode();
  console.log(
    `  ${mem.pass ? "✅ PASS" : "❌ FAIL"}${mem.error ? ` — ${mem.error}` : ""}`,
  );

  console.log("\n--- 2. surrealkv:// 模式 ---");
  const kv = await testSurrealKVMode();
  console.log(
    `  ${kv.pass ? "✅ PASS" : "❌ FAIL"}${kv.error ? ` — ${kv.error}` : ""}`,
  );

  console.log("\n--- 3. file:// 模式 ---");
  const file = await testFileMode();
  console.log(
    `  ${file.pass ? "✅ PASS" : "❌ FAIL"}${file.error ? ` — ${file.error}` : ""}`,
  );

  console.log("\n=== PoC-10 结果汇总 ===");
  console.log(`  mem://        ${mem.pass ? "✅" : "❌"}`);
  console.log(`  surrealkv://  ${kv.pass ? "✅" : "❌"}`);
  console.log(`  file://       ${file.pass ? "✅" : "❌"}`);

  if (!mem.pass && !kv.pass && !file.pass) {
    console.log(
      "\n结论: Bun + @surrealdb/node embedded 模式不可用，需使用 standalone server",
    );
  } else {
    console.log(
      `\n结论: Embedded 可用协议: ${[mem.pass && "mem://", kv.pass && "surrealkv://", file.pass && "file://"].filter(Boolean).join(", ")}`,
    );
  }
}

main().catch(console.error);
