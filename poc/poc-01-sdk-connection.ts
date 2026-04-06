/**
 * PoC-01: Bun + SurrealDB JS SDK (v2.0.3) 连接 SurrealDB 3.x
 *
 * 通过标准:
 *   - CRUD 操作正常工作
 *   - WebSocket 事件监听（live query）正常工作
 *
 * 失败预案: 降级到 HTTP 连接模式
 *
 * SDK v2.0.3 链式 API:
 *   db.create(Table).content(data)
 *   db.update(RecordId).merge(data)
 *   db.select(Table)
 *   db.live(Table) → ManagedLiveSubscription (async iterator / .subscribe())
 */

import { Surreal, Table, StringRecordId } from "surrealdb";

const ENDPOINT = "ws://127.0.0.1:21890";
const NS = "poc";
const DB = "test01";

interface User {
  id?: any;
  name: string;
  age: number;
  email: string;
}

async function testCRUD(db: Surreal): Promise<boolean> {
  console.log("\n--- CRUD 测试 ---");

  // 先清理残留数据
  await db.query("DELETE user");

  // CREATE
  const created = await db
    .create<User>(new Table("user"))
    .content({ name: "张三", age: 30, email: "zhangsan@example.com" });
  console.log("CREATE:", JSON.stringify(created, null, 2));

  const record = Array.isArray(created) ? created[0] : created;
  const userId = record?.id;
  if (!userId) {
    console.error("FAIL: CREATE 未返回 ID");
    return false;
  }
  console.log("User ID:", String(userId));

  // READ (select all)
  const all = await db.select<User>(new Table("user"));
  console.log("SELECT ALL: count =", all.length);
  if (!Array.isArray(all) || all.length !== 1) {
    console.error(`FAIL: SELECT ALL 期望 1 条，实际 ${all.length} 条`);
    return false;
  }

  // UPDATE (merge)
  const updated = await db.update<User>(userId).merge({ age: 31 });
  console.log("MERGE result age:", (updated as any)?.age);

  // READ single
  const single = await db.select<User>(userId);
  if ((single as any)?.age !== 31) {
    console.error("FAIL: MERGE 后 age 未更新");
    return false;
  }

  // DELETE
  await db.delete(userId);

  // Verify delete
  const afterDelete = await db.select(new Table("user"));
  if (Array.isArray(afterDelete) && afterDelete.length > 0) {
    console.error("FAIL: DELETE 后仍有数据");
    return false;
  }

  console.log("✅ CRUD 测试通过");
  return true;
}

async function testQuery(db: Surreal): Promise<boolean> {
  console.log("\n--- SurrealQL 查询测试 ---");

  await db.query("DELETE user");

  await db.query(`
    CREATE user:alice SET name = '爱丽丝', age = 25, email = 'alice@example.com';
    CREATE user:bob SET name = '鲍勃', age = 35, email = 'bob@example.com';
    CREATE user:carol SET name = '卡罗尔', age = 28, email = 'carol@example.com';
  `);

  const result = await db.query<[Array<{ name: string; age: number }>]>(
    "SELECT name, age FROM user WHERE age > $min_age ORDER BY age",
    { min_age: 26 },
  );

  const resultArr = result[0];
  if (!Array.isArray(resultArr) || resultArr.length !== 2) {
    console.error(
      `FAIL: 条件查询 got ${resultArr?.length ?? "undefined"} items, expected 2`,
    );
    return false;
  }
  console.log("条件查询: 卡罗尔(28) + 鲍勃(35) ✓");

  await db.query("DELETE user");
  console.log("✅ SurrealQL 查询测试通过");
  return true;
}

async function testLiveQuery(db: Surreal): Promise<boolean> {
  console.log("\n--- Live Query 测试 ---");

  await db.query("DELETE user");
  const events: Array<{ action: string; result: any }> = [];
  const timeout = 5000;

  try {
    // SDK v2.0.3 返回 ManagedLiveSubscription，需要用 subscribe 或 async iterator
    const subscription = await db.live(new Table("user"));
    console.log("Live subscription created, type:", typeof subscription);
    console.log("  isManaged:", subscription.isManaged);
    console.log("  isAlive:", subscription.isAlive);

    // 方式1: 尝试 subscribe 方法
    if (typeof subscription.subscribe === "function") {
      subscription.subscribe((message) => {
        console.log(`  Live event: action=${message.action}`, JSON.stringify(message.value));
        events.push({ action: String(message.action), result: message.value });
      });
      console.log("  已注册 subscribe 回调");
    }

    // 等待订阅建立
    await new Promise((r) => setTimeout(r, 500));

    // 触发事件
    await db
      .create(new StringRecordId("user:live_test"))
      .content({ name: "直播测试", age: 20 });
    console.log("  已 CREATE user:live_test");

    await db.update(new StringRecordId("user:live_test")).merge({ age: 21 });
    console.log("  已 MERGE user:live_test");

    await db.delete(new StringRecordId("user:live_test"));
    console.log("  已 DELETE user:live_test");

    // 等待事件到达
    const start = Date.now();
    while (events.length < 3 && Date.now() - start < timeout) {
      await new Promise((r) => setTimeout(r, 100));
    }

    console.log(`  收到 ${events.length} 个事件（预期 3 个）`);

    // 取消订阅
    await subscription.kill();

    if (events.length >= 3) {
      console.log("✅ Live Query 测试通过");
      return true;
    } else {
      console.warn(
        `⚠️ Live Query 仅收到 ${events.length}/3 个事件（${timeout}ms 超时）`,
      );
      return false;
    }
  } catch (err) {
    console.error("Live Query 异常:", err);
    return false;
  }
}

async function testLiveQueryIterator(db: Surreal): Promise<boolean> {
  console.log("\n--- Live Query (Async Iterator) 测试 ---");

  await db.query("DELETE user");
  const events: Array<any> = [];
  const timeout = 5000;

  try {
    const subscription = await db.live(new Table("user"));

    // 方式2: 用 async iterator 在后台收集事件
    const collector = (async () => {
      for await (const event of subscription) {
        console.log("  Iterator event:", JSON.stringify(event));
        events.push(event);
        if (events.length >= 3) break;
      }
    })();

    await new Promise((r) => setTimeout(r, 500));

    await db
      .create(new StringRecordId("user:iter_test"))
      .content({ name: "迭代器测试", age: 22 });
    console.log("  已 CREATE user:iter_test");

    await db.update(new StringRecordId("user:iter_test")).merge({ age: 23 });
    console.log("  已 MERGE user:iter_test");

    await db.delete(new StringRecordId("user:iter_test"));
    console.log("  已 DELETE user:iter_test");

    // 等待事件或超时
    await Promise.race([
      collector,
      new Promise((r) => setTimeout(r, timeout)),
    ]);

    console.log(`  收到 ${events.length} 个事件（预期 3 个）`);

    await subscription.kill();

    if (events.length >= 3) {
      console.log("✅ Live Query (Iterator) 测试通过");
      return true;
    } else {
      console.warn(
        `⚠️ Live Query (Iterator) 仅收到 ${events.length}/3 个事件`,
      );
      return false;
    }
  } catch (err) {
    console.error("Live Query (Iterator) 异常:", err);
    return false;
  }
}

async function main() {
  console.log("=== PoC-01: Bun + SurrealDB JS SDK 连接测试 ===");
  console.log(`Endpoint: ${ENDPOINT}`);
  console.log(`Bun: ${Bun.version}`);

  const db = new Surreal();

  try {
    await db.connect(ENDPOINT);
    console.log("✅ WebSocket 连接成功");

    await db.signin({ username: "root", password: "root" });
    console.log("✅ 认证成功");

    await db.use({ namespace: NS, database: DB });
    console.log(`✅ 已选择 ${NS}/${DB}`);

    const crudPass = await testCRUD(db);
    const queryPass = await testQuery(db);
    const livePass1 = await testLiveQuery(db);
    const livePass2 = await testLiveQueryIterator(db);

    await db.query("DELETE user");

    console.log("\n=== PoC-01 结果汇总 ===");
    console.log(`CRUD:                 ${crudPass ? "✅ PASS" : "❌ FAIL"}`);
    console.log(`SurrealQL:            ${queryPass ? "✅ PASS" : "❌ FAIL"}`);
    console.log(
      `Live Query (subscribe): ${livePass1 ? "✅ PASS" : "⚠️ FAIL"}`,
    );
    console.log(
      `Live Query (iterator):  ${livePass2 ? "✅ PASS" : "⚠️ FAIL"}`,
    );

    const livePass = livePass1 || livePass2;
    console.log(
      `\n总结: ${crudPass && queryPass ? "CRUD + 查询正常" : "存在失败项"}${livePass ? "，Live Query 可用" : "，Live Query 均不可用"}`,
    );

    if (!livePass) {
      console.log(
        "失败预案: 不依赖 SurrealDB live query，使用应用层 EventBus + WebSocket",
      );
    }
  } catch (err) {
    console.error("连接/认证失败:", err);
    process.exit(1);
  } finally {
    await db.close();
  }
}

main();
