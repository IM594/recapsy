# Phase 0 PoC 验证结果

> **执行日期：** 2026-04-06
> **环境：** Bun 1.2.10, macOS arm64, SurrealDB 3.0.4 (standalone memory mode), surrealdb SDK 2.0.3, @surrealdb/node 3.0.3, jieba-wasm 2.4.0

## 总结

**Phase 0 通过。** SurrealDB 3.x 全部 10 项 PoC 验证通过，jieba-wasm 在 Bun 下完全兼容。可进入 Phase 1。

## SurrealDB 3.x 验证（10/10 通过）

| # | 验证项 | 状态 | 关键发现 |
|---|--------|------|----------|
| 1 | SDK 连接 + CRUD + Live Query | ✅ PASS | SDK v2.0.3 chain API（`db.create(Table).content()`）；Live Query 推荐 async iterator 模式 |
| 2 | 崩溃恢复 | ✅ PASS | standalone + surrealkv:// 路径，100 条数据 kill -9 后全部恢复 |
| 3 | 10 万条向量搜索 | ✅ PASS | 100k/1024D HNSW P95=168ms, P50=142ms；KNN 语法需 EF 参数 `<\|K,EF\|>` |
| 4 | 中文预分词全文搜索 | ✅ PASS | 85.4% 平均召回率；3.x 语法 `FULLTEXT ANALYZER`（非 2.x 的 `SEARCH ANALYZER`）；jieba 需自定义词典优化 |
| 5 | HNSW 并发写入 | ✅ PASS | 5 并发写 + 2 搜索，0 死锁 0 错误，1500 条全部写入 |
| 6 | SDK 绑定方式 | ✅ PASS | WS/HTTP/Embedded(mem:// + surrealkv://) 四种模式全通过；推荐 WebSocket |
| 7 | 事务原子性 | ✅ PASS | COMMIT 正常；CANCEL 回滚数据不变（抛 QueryError kind=Cancelled）；批量原子性正常 |
| 8 | HNSW + null embedding | ✅ PASS | `option<array<float>>` 中 null embedding 自动排除在 KNN 结果外 |
| 9 | Export 可用性 | ✅ PASS | SDK db.export()、CLI surreal export、SurrealQL SELECT 三种方式均可用 |
| 10 | Embedded 启动方式 | ✅ PASS | mem:// 和 surrealkv:// 可用，file:// 不支持（engine 未注册） |

## 其他依赖验证

| # | 验证项 | 状态 | 关键发现 |
|---|--------|------|----------|
| 11 | jieba-wasm Bun 兼容性 | ✅ PASS | WASM 加载正常，精确/全/搜索模式全通过，性能 0.016ms/次，12.5k 字符大文本稳定，并发安全 |

## 最终决策

### PoC-12: Embedded vs Standalone

**决策：Standalone 模式 + WebSocket 连接**

理由：
1. Standalone 支持 live query（WS 事件推送），embedded 不直接支持
2. CLI 调试友好（surreal sql / surreal export 可直接连接）
3. 多进程隔离更健壮（DB 崩溃不影响 Engine 进程）
4. @surrealdb/node 的 N-API 绑定在 Bun 下虽可用，但长期稳定性不如官方 WS/HTTP 协议
5. launchd 管理进程生命周期，可独立重启

配置要点：
- 连接模式：`ws://127.0.0.1:21890`
- 存储协议：`surrealkv://` （持久化目录：`~/Library/Application Support/RecaplySense/db/`）
- 备选：如 WS 出问题，可无缝降级为 HTTP 连接

## 发现的 SurrealDB 3.x 语法差异

以下是与 2.x 文档/internet 信息不同的要点，实现阶段需注意：

1. **SDK 导入**：`import { Surreal, Table, StringRecordId } from "surrealdb"`（无默认导出）
2. **CRUD API**：chain 模式 `db.create(new Table("x")).content({...})`，`db.update(id).merge({...})`
3. **KNN 语法**：`<|K,EF|>`（必须带 EF 参数），如 `<|10,100|>`
4. **FTS 语法**：`DEFINE ANALYZER ... TOKENIZERS blank; DEFINE INDEX ... FULLTEXT ANALYZER ...`（非 `SEARCH ANALYZER ... BM25`）
5. **DELETE 空表**：SurrealDB 3.x 中 DELETE 不存在的表抛 NotFoundError，用 `REMOVE TABLE IF EXISTS` 代替
6. **Embedded 引擎**：`const { createNodeEngines } = await import("@surrealdb/node")`（非 `SurrealNode`）
7. **Live Query**：返回 `ManagedLiveSubscription`，用 `for await (const event of sub) {...}` 消费，用 `sub.kill()` 关闭
8. **CANCEL 事务**：抛 QueryError（kind=Cancelled），但数据回滚正常
