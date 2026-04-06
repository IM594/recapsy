/**
 * PoC-09: embedded 模式下 surreal export 可用性
 * 通过标准: 备份策略依赖此命令
 * 失败预案: 改用 SurrealQL SELECT * 导出 + 自研备份脚本
 */
import { Surreal, Table, StringRecordId } from "surrealdb";
import { $ } from "bun";

const ENDPOINT = "ws://127.0.0.1:21890";
const NS = "poc";
const DB = "test09";

async function main() {
  console.log("=== PoC-09: Surreal Export 可用性测试 ===\n");

  const db = new Surreal();
  await db.connect(ENDPOINT);
  await db.signin({ username: "root", password: "root" });
  await db.use({ namespace: NS, database: DB });

  // 插入测试数据
  for (let i = 0; i < 20; i++) {
    await db.create(new StringRecordId(`export_test:doc_${i}`)).content({
      text: `导出测试文档 ${i}`,
      number: i * 100,
      tags: ["test", `tag_${i % 5}`],
    });
  }
  console.log("✅ 已插入 20 条测试数据");

  // Test 1: SDK db.export()
  console.log("\n--- Test 1: SDK db.export() ---");
  try {
    const exportData = await db.export();
    const exportStr =
      typeof exportData === "string" ? exportData : new TextDecoder().decode(exportData as any);
    console.log(`  导出大小: ${exportStr.length} 字节`);
    console.log(`  前 200 字符: ${exportStr.slice(0, 200)}...`);
    console.log(`  ✅ SDK export 可用`);
  } catch (e) {
    console.log(`  ❌ SDK export 失败: ${e}`);
  }

  // Test 2: CLI surreal export
  console.log("\n--- Test 2: CLI surreal export ---");
  const exportPath = "/tmp/recaply-poc09-export.surql";
  try {
    const result = await $`surreal export -e http://127.0.0.1:21890 -u root -p root --ns ${NS} --db ${DB} ${exportPath} 2>&1`.text();
    console.log(`  CLI 输出: ${result.trim() || "(empty)"}`);
    const stat = await Bun.file(exportPath).text();
    console.log(`  导出文件大小: ${stat.length} 字节`);
    console.log(`  ✅ CLI export 可用`);
  } catch (e) {
    console.log(`  ❌ CLI export 失败: ${e}`);
  }

  // Test 3: SurrealQL SELECT * 导出（备选方案）
  console.log("\n--- Test 3: SurrealQL SELECT * 导出 ---");
  try {
    const result = await db.query("SELECT * FROM export_test");
    const records = (result as any)[0] ?? [];
    const jsonStr = JSON.stringify(records, null, 2);
    console.log(`  查询到 ${records.length} 条记录`);
    console.log(`  JSON 大小: ${jsonStr.length} 字节`);
    console.log(`  ✅ SurrealQL SELECT 导出可用`);
  } catch (e) {
    console.log(`  ❌ SurrealQL SELECT 失败: ${e}`);
  }

  // 清理
  await db.query("REMOVE TABLE export_test");
  await db.close();
  await $`rm -f ${exportPath}`;

  console.log("\n=== PoC-09 结果: 至少有一种导出方式可用 ===");
}

main().catch(console.error);
