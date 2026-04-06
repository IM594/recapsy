/**
 * PoC-07: Client-side transactions 原子性验证
 * 通过标准: 事务隔离级别、回滚行为符合预期
 * 失败预案: 改用 SurrealQL 批量语句代替事务
 */
import { Surreal, Table, StringRecordId } from "surrealdb";

const ENDPOINT = "ws://127.0.0.1:21890";
const NS = "poc";
const DB = "test07";

async function main() {
  console.log("=== PoC-07: 事务原子性测试 ===\n");

  const db = new Surreal();
  await db.connect(ENDPOINT);
  await db.signin({ username: "root", password: "root" });
  await db.use({ namespace: NS, database: DB });

  await db.query(`
    DEFINE TABLE IF NOT EXISTS account SCHEMAFULL;
    DEFINE FIELD IF NOT EXISTS name ON account TYPE string;
    DEFINE FIELD IF NOT EXISTS balance ON account TYPE int;
    DELETE account;
  `);

  // 初始数据
  await db.create(new StringRecordId("account:alice")).content({ name: "Alice", balance: 1000 });
  await db.create(new StringRecordId("account:bob")).content({ name: "Bob", balance: 500 });

  // Test 1: 成功事务 — 转账
  console.log("--- Test 1: 成功事务（转账 200）---");
  try {
    await db.query(`
      BEGIN;
      UPDATE account:alice SET balance = balance - 200;
      UPDATE account:bob SET balance = balance + 200;
      COMMIT;
    `);
    const [alice, bob] = await Promise.all([
      db.select(new StringRecordId("account:alice")),
      db.select(new StringRecordId("account:bob")),
    ]);
    const aliceBal = (alice as any)?.balance;
    const bobBal = (bob as any)?.balance;
    console.log(`  Alice: ${aliceBal} (预期 800), Bob: ${bobBal} (预期 700)`);
    console.log(`  ${aliceBal === 800 && bobBal === 700 ? "✅ PASS" : "❌ FAIL"}`);
  } catch (e) {
    console.log("  ❌ 事务执行失败:", e);
  }

  // Test 2: 回滚事务
  console.log("\n--- Test 2: 事务回滚 ---");
  try {
    await db.query(`
      BEGIN;
      UPDATE account:alice SET balance = balance - 500;
      UPDATE account:bob SET balance = balance + 500;
      CANCEL;
    `);
    const [alice, bob] = await Promise.all([
      db.select(new StringRecordId("account:alice")),
      db.select(new StringRecordId("account:bob")),
    ]);
    const aliceBal = (alice as any)?.balance;
    const bobBal = (bob as any)?.balance;
    console.log(`  Alice: ${aliceBal} (预期 800 不变), Bob: ${bobBal} (预期 700 不变)`);
    console.log(`  ${aliceBal === 800 && bobBal === 700 ? "✅ PASS" : "❌ FAIL"}`);
  } catch (e) {
    console.log("  事务回滚异常:", e);
    // 验证数据没变
    const [alice, bob] = await Promise.all([
      db.select(new StringRecordId("account:alice")),
      db.select(new StringRecordId("account:bob")),
    ]);
    const aliceBal = (alice as any)?.balance;
    const bobBal = (bob as any)?.balance;
    console.log(`  回滚后 Alice: ${aliceBal}, Bob: ${bobBal}`);
    console.log(`  ${aliceBal === 800 && bobBal === 700 ? "✅ 数据未变 PASS" : "❌ FAIL"}`);
  }

  // Test 3: 事务中错误导致的原子性
  console.log("\n--- Test 3: 事务中错误的原子性 ---");
  try {
    await db.query(`
      BEGIN;
      UPDATE account:alice SET balance = balance - 300;
      UPDATE account:nonexistent SET balance = 999;
      COMMIT;
    `);
    console.log("  事务未报错");
  } catch (e) {
    console.log("  事务报错（预期行为）");
  }

  const [aliceFinal, bobFinal] = await Promise.all([
    db.select(new StringRecordId("account:alice")),
    db.select(new StringRecordId("account:bob")),
  ]);
  const af = (aliceFinal as any)?.balance;
  const bf = (bobFinal as any)?.balance;
  console.log(`  Alice: ${af}, Bob: ${bf}`);
  console.log(`  注意: SurrealDB 对 UPDATE 不存在的记录不报错，行为取决于 SCHEMAFULL/SCHEMALESS`);

  // Test 4: 多语句批量原子性（BEGIN/COMMIT）
  console.log("\n--- Test 4: 批量语句原子性 ---");
  await db.query("DELETE account");
  await db.create(new StringRecordId("account:a")).content({ name: "A", balance: 100 });
  await db.create(new StringRecordId("account:b")).content({ name: "B", balance: 200 });

  await db.query(`
    BEGIN;
    UPDATE account:a SET balance = balance + 50;
    UPDATE account:b SET balance = balance - 50;
    COMMIT;
  `);
  const [a, b] = await Promise.all([
    db.select(new StringRecordId("account:a")),
    db.select(new StringRecordId("account:b")),
  ]);
  console.log(`  A: ${(a as any)?.balance} (预期 150), B: ${(b as any)?.balance} (预期 150)`);
  console.log(`  ${(a as any)?.balance === 150 && (b as any)?.balance === 150 ? "✅ PASS" : "❌ FAIL"}`);

  console.log("\n=== PoC-07 结果: 事务原子性验证完成 ===");

  await db.query("REMOVE TABLE account");
  await db.close();
}

main().catch(console.error);
