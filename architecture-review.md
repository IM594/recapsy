# Recaply Sense — 架构 Review & 实现路线图

> **生成日期：** 2026-04-06
> **基于文档版本：** 0.1.0（docs/architecture/ + docs/conventions/）
> **用途：** 指导各阶段实现 Agent 的工作，包含风险清单、改进建议和分阶段工作计划

---

## 使用指南

本文档是**实现阶段的主控文件**。请各 Agent 遵循以下规则：

1. **按 Phase 顺序执行**，不得跳跃（除非前置 Phase 已全部 ✅）
2. **每完成一项任务**，将对应的 `[ ]` 改为 `[x]` 并注明完成日期
3. **遇到阻塞**时，在对应任务下方添加 `> ⛔ BLOCKED: <原因>` 注释
4. **Phase 0 是硬性门槛**——任何 PoC 项未通过，必须在此处记录失败原因和替代决策，不得继续后续 Phase
5. **发现新问题**时，追加到 [§附录 A: 实现过程中发现的新问题](#附录-a-实现过程中发现的新问题)
6. **架构变更**必须同步更新 `docs/architecture/` 对应文档，并在本文件记录变更摘要

### 状态图例

| 标记  | 含义           |
| ----- | -------------- |
| `[ ]` | 待完成         |
| `[x]` | 已完成         |
| `[~]` | 进行中         |
| `[-]` | 跳过（附理由） |

---

## 目录

- [一、架构整体评价](#一架构整体评价)
- [二、高风险问题（实现前必须解决）](#二高风险问题实现前必须解决)
- [三、中风险问题（实现过程中会碰到）](#三中风险问题实现过程中会碰到)
- [四、设计改进建议](#四设计改进建议)
- [五、分阶段实现计划](#五分阶段实现计划)
- [六、风险与任务总结矩阵](#六风险与任务总结矩阵)
- [附录 A: 实现过程中发现的新问题](#附录-a-实现过程中发现的新问题)
- [附录 B: 架构变更日志](#附录-b-架构变更日志)
- [附录 C: 设计预留清单](#附录-c-设计预留清单phase-0-讨论产出)

---

## 一、架构整体评价

**设计质量：优秀。** 文档体系完整度在个人项目中罕见——19 个技术决策均有否决方案和理由记录，模块边界矩阵清晰，数据模型和 API 契约覆盖全面。

**主要优势：**

- 三端分离（Frontend / Collector / Engine）边界明确，职责不重叠
- SurrealDB 多模型统一存储避免了"SQLite + 向量扩展 + 图数据库"的拼凑方案
- MCP Server 只暴露原始工具、不暴露 Agent，避免 Agent 套 Agent 的反模式
- Vision LLM 按 App Session 触发而非逐帧调用，成本模型合理
- NER 二级策略（本地规则 80% + 云端 LLM 降级）兼顾成本和质量
- Repository 抽象层为未来数据库替换留了出路
- AI SDK（Vercel）统一了多 Provider 调用，Agent 编排简洁

**主要风险集中在：** SurrealDB 生态成熟度、Bun 生态兼容性（jieba-wasm、onnxruntime-node）、以及若干运维场景的边界条件。

---

## 二、高风险问题（实现前必须解决）

### 2.1 SurrealDB 验证（已升级到 3.x）

SurrealDB 3.x 是整个数据层的唯一支撑。虽然 3.0 在 HNSW 并发写入、内存管理、事务语义上相比 2.x 有显著提升，但作为相对年轻的数据库，**TDR-004 的 PoC 清单必须在写任何业务代码之前完成。**

> **版本说明：** 项目已决定使用 SurrealDB 3.x（v3.0.5+），JS SDK `surrealdb@^2.0.3`（已完整支持 3.0）。
> 3.0 的 HNSW 并发写入和 memory-bounded LRU cache 缓解了部分原始风险，但仍需实测验证。

**PoC 清单（合并原始 + 补充，共 10 项）：**

| #   | 验证项                                             | 通过标准                                                     | 失败预案                                               |
| --- | -------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| 1   | Bun + SurrealDB JS SDK (v2.0.3) 连接 SurrealDB 3.x | CRUD + WebSocket 事件监听正常工作                            | 降级到 HTTP 连接模式                                   |
| 2   | 嵌入式模式崩溃恢复                                 | kill -9 后重启，数据无丢失                                   | 评估 standalone server 模式                            |
| 3   | 10 万条向量搜索                                    | HNSW 搜索延迟 < 200ms (P95)                                  | 评估降维策略                                           |
| 4   | 中文预分词全文搜索                                 | jieba 分词 + blank tokenizer 召回率可接受                    | 加重向量搜索权重，FTS 降级为辅助                       |
| 5   | HNSW 并发写入（3.0 新特性）                        | ingestion 写入 + search 查询并发无死锁，验证并发写入实际性能 | 引入读写队列化                                         |
| 6   | Bun + `surrealdb` SDK 绑定兼容性                   | 确认在 Bun 下使用 WASM/N-API/HTTP 哪种模式最稳定             | 使用纯 HTTP 连接模式                                   |
| 7   | Client-side transactions 原子性实测（3.0 新特性）  | 事务隔离级别、回滚行为符合预期                               | 改用 SurrealQL 批量语句代替事务                        |
| 8   | HNSW 索引 + `option<array<float>>` 行为            | embedding 为 null 时 HNSW 索引自动跳过该记录                 | 搜索查询中强制加 `WHERE embedding IS NOT NULL`         |
| 9   | embedded 模式下 `surreal export` 可用性            | 备份策略依赖此命令                                           | 改用 SurrealQL `SELECT * FROM ...` 导出 + 自研备份脚本 |
| 10  | SurrealDB embedded 模式的启动方式                  | SDK `connect("file://...")` 正常工作，内存管理可控           | 降级为 standalone server（launchd 额外管理一个进程）   |

**如果 SurrealDB 整体不达标的保底方案：** Repository 抽象层已预留替换能力，但需注意——如果降级到 SQLite + sqlite-vec，图查询能力（`appeared_in`、`related_to` 边模型）将丧失，需要改用 JOIN 模拟或放弃实体关系图功能。建议在 PoC 阶段同步评估 SQLite + DuckDB 的保底可行性。

### 2.2 MCP stdio 进程 vs Engine 进程的启动顺序

**问题：** 文档说 stdio 模式 MCP Server "通过 HTTP 调用主 Engine API"（避免 SurrealDB 锁竞争），但存在启动顺序问题：

- Claude Desktop / Cursor 启动 MCP Server 进程时，Engine 可能还没启动
- stdio MCP 进程没有 launchd 托管，无法自动确保 Engine 在线

**建议：** stdio MCP 进程启动时应先健康检查 Engine（轮询 `GET /health`，指数退避，最大等待 30s），如果不可用则返回有意义的 MCP 错误响应（如 `"Recaply Sense Engine is not running. Please start the app first."`），而不是静默失败。

### 2.3 时间到底按什么算？

screenshot 表已经存了 `timezone`、`local_date`、`local_hour`，说明我们想做的是"按用户采集时的本地时间来组织记忆"。但 timeline 和 timeline/summary 的 API 默认走的是 UTC，`activity_segment` 上也没有对应的本地时间字段。

这会怎样？用户在杭州（UTC+8）晚上 11 点做的事，按 UTC 算就变成"明天"了。"今天做了什么"这种最基本的查询就会错。而且一旦数据入库了，后面修起来非常痛苦。

**建议（Phase 1 schema 设计时冻结）：**

- 所有时间戳统一存 UTC（`captured_at`、`created_at` 等）
- 所有需要"按天聚合"的表（screenshot、activity_segment）都派生 `capture_timezone` + `local_date` + `local_hour`
- API 层：如果请求没带 `timezone` 参数，用 screenshot 自身的 `capture_timezone` 来做日聚合，而不是默认 UTC
- activity_segment 补上 `timezone`、`local_date` 字段

### 2.4 搜索结果分页：一锅端还是分开查？

现在 `POST /search` 一个接口同时返回 screenshots、entities、activity_segments 三种结果，但只有一组 `limit`/`offset`/`total_count`。问题是：这个分页到底是对混合结果生效，还是对每类结果分别生效？文档没说清楚。

客户端拿到一页数据后，不知道是"所有类型各取了 20 条"还是"混在一起取了 20 条里碰巧有 15 条截图 + 3 个实体 + 2 个 segment"。MCP 消费方、SwiftUI 列表、缓存层都会被这个不确定性搞晕。

**建议（Phase 3 实现前冻结）：**

选一种，别骑墙：

- **方案 A：统一结果流。** 所有类型混在一起排序，一组分页参数，客户端按 `type` 字段区分渲染。简单，但不好做"只看截图"的分页。
- **方案 B：分通道查询。** 每种类型独立的 `limit`/`offset`，或者干脆拆成 `/search/screenshots`、`/search/entities`、`/search/segments`。灵活，但请求变多。

我倾向 MVP 先用方案 A（一个接口、混合排序、一组分页），等 UI 需求明确了再拆。但不管选哪个，Phase 3 开工前必须定下来。

### 2.5 activity_segment 的实体数据存了两份

现在 segment 里有个 `key_entities` 数组（内联存的），同时又建了 `appeared_in_segment` 图边（关系型存的）。两份数据说的是同一件事，但文档没定义谁才是真相来源。

这会怎样？实体合并的时候，你改了图边忘了改数组（或者反过来），数据就不一致了。segment 重试、截图清理的时候也一样，两边都得同步更新，很容易漏。

**建议（Phase 1 schema 设计时决定）：**

- **图边是真相，`key_entities` 是缓存。** 查询 segment 详情时从图边实时聚合；`key_entities` 只在 segment 创建时写一次快照，用于列表页快速展示，不参与任何修改逻辑。
- 实体合并、清理等操作只需要维护图边，`key_entities` 不用管（或者定期重建）。

### 2.6 内存预算对不上

性能基线文档写的是 Engine 稳态内存 < 200MB。但运维文档又算过：50 万截图时 HNSW 要 3-5GB，100 万截图时三张表合计 8-10GB。这两个数字差了 50 倍，不是同一个量级的事。

如果 < 200MB 是"不算向量索引的基础进程内存"，那应该说清楚。如果健康检查、告警、产品宣传都按 200MB 来，用户跑几个月之后内存一定会爆。

**建议（Phase 1 开始前修正文档）：**

- 把"稳态内存 < 200MB"改成"基础进程内存（不含向量索引）< 200MB"
- 补一个分阶段的实际内存预算表：1 万截图 / 10 万 / 50 万 / 100 万各预计多少
- 如果百万级真的要 8-10GB，就得提前想好冷热分层策略（比如只索引最近 N 天的向量），不能等数据涨上去了再改

### 2.7 jieba-wasm + Bun 兼容性

jieba-wasm 是中文全文搜索的关键依赖。WASM 在 Bun 中的运行基本支持，但初始化时间和内存开销需要实测。

**备选方案（如果 jieba-wasm 不可用）：**

- `@aspect-build/segment`（纯 JS 中文分词）
- Intl.Segmenter（Bun 内置，V8 ICU 分词，精度较低但零依赖）
- 直接加重向量搜索权重，弱化 FTS 中文通道

---

## 三、中风险问题（实现过程中会碰到）

### 3.1 Vision Session 重建问题

**问题：** Vision LLM 失败时，用 `vision_pending = true` 标记 screenshot。但重试时如何重建 session 上下文？

- `sessionManager` 管理的是内存中的活跃 session
- Engine 重启后，活跃 session 信息丢失
- 重试时无法知道哪些 screenshot 属于同一个 session

**建议：** 在 `activity_segment` 写入前，先写一条 `status = 'pending'` 的 segment 记录（含 `screenshot_ids`、`bundle_id`、`session_start/end`），LLM 成功后更新为完整记录。这样重试时有据可查。同时 Vision 模块应同时监听 EventBus（快速路径）和定时扫描 DB（恢复路径），双通道保证不丢失。

### 3.2 Collector 批量回放可能压垮 Ingestion

**问题：** Collector 离线恢复后使用 `/ingest/batch` 批量回放，每批 100 条、批间 500ms。如果积攒了 10 万条：

- 回放时间 = 100,000 / 100 × 0.5s = **500 秒（~8 分钟）**
- 同时 Collector 还在继续产生新截图
- Ingestion Pipeline 同时处理新截图 + 旧截图，队列深度暴增

**建议：** 使用专门的 `backfill` 队列与正常队列分离。正常截图高优先级，回放数据低优先级。回放速率可配置，且在队列深度 > N 时自动降速。

### 3.3 Embedding 模型变更无迁移路径

**问题：** 文档说云端和本地使用同一 BGE-M3 模型（1024 维），避免向量不兼容。但如果未来模型版本更新（如 BAAI 发布 v2），旧向量和新向量的语义空间可能不一致。

**建议：** 在 `screenshot`、`entity`、`activity_segment` 表中增加 `embedding_model` 字段（如 `"bge-m3-v1"`），方便未来做增量重建。在 Phase 1 schema 设计时加入。

### 3.4 Zod → JSON Schema → quicktype 工具链脆弱

**问题：** TDR-015 的类型同步方案有已知痛点：

- Zod v4 的某些特性（`z.discriminatedUnion`、`z.transform`）可能无法完美转 JSON Schema
- quicktype 生成的 Swift 代码可能需要手动调整
- CI 中的 diff 检查如果过于严格，会频繁破坏构建

**建议：** MVP 阶段手动维护 Swift 类型（共享类型并不多），等接口稳定后再引入自动生成。过早引入自动化反而增加摩擦。

### 3.5 EventBus 无持久化 — 事件丢失风险

**问题：** `ingestion:done` 事件触发 Vision 处理，但 EventBus 是纯内存的 typed EventEmitter。如果 Engine 在 emit 后、Vision 处理前崩溃，事件丢失。

**建议：** 让 Ingestion 写入 screenshot 时直接设 `vision_pending = true`（持久化状态），Vision 模块同时监听 EventBus（快速路径）和定时扫描 `vision_pending = true`（恢复路径），双通道保证不丢失。当前 `vision_pending` 标记已存在于 schema 中，只需确保 Ingestion 在写入时就设置它。

### 3.6 ProcessManager.swift 名字和职责含糊

Phase 6 的 Desktop UI 里列了 `ProcessManager.swift`，注释写的是"LaunchAgent 注册（SMAppService）"。但 `ProcessManager` 这个名字听起来像是"管理子进程的启停"，跟 TDR 里"Frontend 不负责后端进程启停、交给 launchd"的决策矛盾。

名字不改的话，后面写代码的人（或者 Agent）很可能会往里面塞 `Process.launch()` 之类的子进程管理逻辑。

**建议：** 改名为 `LaunchAgentManager.swift`，职责限定为：注册/注销 LaunchAgent、查询 Collector/Engine 运行状态、不直接启停进程。

### 3.7 文档里的小矛盾，趁没代码赶紧改

几个地方对不上，现在改成本很低，等写了代码再改就烦了：

- **lockfile 名字不统一：** 目录文档写 `bun.lockb`，依赖管理和 CI 写的是 `bun.lock`（Bun 1.2+ 默认是 `bun.lock`）
- **workspaces 范围：** `bun run dev` 多处写着"全部启动"，但 `apps/*` 明确不在 workspaces 里，Turborepo 编排不到
- **目录命名：** 有些地方写 `frontend/collector/engine`，有些写 `apps/desktop` + `packages/*`

**建议：** Phase 1 搭骨架的时候统一扫一遍，以实际 monorepo 配置为准把文档对齐。

### 3.8 CI 保护力度不够

测试策略要求 E2E 测试和 80% 覆盖率，但 CI pipeline 的 build 只依赖 `test-unit`，分支保护也只卡 unit test。E2E 和集成测试根本没进流水线。

对这个项目来说问题不大（早期一个人开发），但等到 Collector + Engine + DB 联调的时候，光靠 unit test 拦不住存储和迁移相关的问题。

**建议：** 不急着现在改，但 Phase 3（搜索）做完以后，把集成测试加进 CI。E2E 可以再晚一些，等 Collector 联调时再说。

---

## 四、设计改进建议

### 4.1 `activity_segment` 缺少版本标记

Vision LLM 的 prompt 可能随版本迭代调整，导致新旧 segment 的 `scene_type` 分类、`summary` 风格不一致。

**建议：** 增加字段：

```surql
DEFINE FIELD schema_version ON activity_segment TYPE int DEFAULT 1;
```

### 4.2 截图清理后的搜索一致性

清理策略中 `purged = true` 的记录清空了 `ocr_text` 和 `embedding`，但 `activity_segment.screenshot_ids` 仍引用这些截图。用户点击 segment 关联的截图时会看到空白。

**建议：** 在 `activity_segment` 中缓存一份截图预览信息（如 OCR 摘要前 100 字），这样即使原始截图被清理，segment 仍可展示有意义的内容。或者在清理时更新 segment 的引用状态。

### 4.3 简化 Collector Token

`X-Collector-Token` 的设计初衷是"区分流量"而非安全，但引入 token 带来了生成、存储、分发、校验的完整链路。

**建议：** MVP 阶段用 `User-Agent: RecaplyCollector/0.1` header 区分即可，省去 token 管理复杂度。安全 token 留到需要网络暴露时再加。

### 4.4 补充 `embedding_model` 字段

为未来 Embedding 模型升级预留迁移路径：

```surql
DEFINE FIELD embedding_model ON screenshot TYPE string DEFAULT 'bge-m3-v1';
DEFINE FIELD embedding_model ON entity TYPE string DEFAULT 'bge-m3-v1';
DEFINE FIELD embedding_model ON activity_segment TYPE string DEFAULT 'bge-m3-v1';
```

---

## 五、分阶段实现计划

### 为什么这个顺序？

1. **Phase 0 先行**：SurrealDB 是最大不确定性，早验证早决策
2. **Engine 从底层往上建**：storage → ingestion → search → agent，严格遵循依赖方向
3. **Collector 放在 Phase 5**：在 Collector 完成前，可以用脚本模拟截图输入来测试 Engine
4. **UI 最后做**：在所有后端 API 就绪前做 UI 是浪费时间，且 API 接口可能在 Phase 2-4 中变化

---

### Phase 0 — PoC 验证（1-2 天）🚨 硬性门槛

> **目标：** 验证 SurrealDB 3.x 的 10 项 PoC + jieba-wasm 兼容性
> **产出：** 独立的 `poc/` 目录，包含所有验证脚本和结论
> **决策门：** 如果 SurrealDB 不达标，此时切换 DB 成本最低

**SurrealDB 3.x 验证：**

- [x] PoC-01: Bun + SurrealDB JS SDK (v2.0.3) 连接 SurrealDB 3.x（CRUD + WS 事件监听）— 2026-04-06（PASS：CRUD + SurrealQL + Live Query 全部通过；Live Query 推荐用 async iterator 方式）
- [x] PoC-02: 嵌入式模式崩溃恢复（kill -9 后重启，数据无丢失）— 2026-04-06（PASS：standalone + `surrealkv://` 路径，100条数据 kill -9 后全部恢复）
- [x] PoC-03: 10 万条向量搜索（HNSW 搜索延迟 < 200ms P95）— 2026-04-06（PASS：100k/1024D P95=168ms；注意 KNN 语法需带 EF 参数 `<|K,EF|>`）
- [x] PoC-04: 中文预分词全文搜索（jieba 分词 + blank tokenizer 召回率验证）— 2026-04-06（PASS：85.4% 平均召回率；注意 3.x 语法为 `FULLTEXT ANALYZER`；jieba 需自定义词典优化"微信"等词）
- [x] PoC-05: HNSW 并发写入（3.0 新特性，ingestion 写 + search 读同时进行）— 2026-04-06（PASS：5 并发写入 + 搜索，0 死锁 0 错误，1500 条全部写入）
- [x] PoC-06: Bun + SurrealDB SDK 绑定方式确认（WASM vs N-API vs HTTP）— 2026-04-06（PASS：WS/HTTP/Embedded mem:///surrealkv:// 四种模式全部通过；推荐 WebSocket，支持 live query）
- [x] PoC-07: Client-side transactions 原子性验证（3.0 新特性，隔离级别、回滚行为）— 2026-04-06（PASS：COMMIT 正常，CANCEL 回滚后数据不变，批量原子性正常）
- [x] PoC-08: HNSW + option embedding 行为（null embedding 是否被索引跳过）— 2026-04-06（PASS：null embedding 记录自动排除在 KNN 和 IS NOT NONE 过滤结果外）
- [x] PoC-09: embedded 模式下 surreal export 可用性 — 2026-04-06（PASS：SDK db.export()、CLI surreal export、SurrealQL SELECT 三种方式均可用）
- [x] PoC-10: embedded 模式启动方式和内存管理 — 2026-04-06（PASS：mem:// 和 surrealkv:// 可用，file:// 不支持；@surrealdb/node createNodeEngines() 在 Bun 下正常工作）

**其他关键依赖验证：**

- [x] PoC-11: jieba-wasm 在 Bun 下的兼容性（初始化时间、内存占用、分词质量）— 2026-04-06（PASS：WASM 加载正常，精确/全/搜索模式全通过，性能 0.016ms/次，12.5k 字符大文本稳定，并发安全）
- [x] PoC-12: SurrealDB embedded vs standalone 模式最终选型决策 — 2026-04-06（决策：**推荐 standalone 模式 + WebSocket 连接**。理由：①standalone 支持 live query（embedded 不支持 WS 事件推送）②standalone 方便 CLI 调试（surreal sql/export）③多进程隔离更健壮④embedded @surrealdb/node 在 Bun 下虽可用但属于 N-API 绑定，长期稳定性不如官方 WS/HTTP 协议⑤standalone 用 launchd 管理，进程生命周期可控。备注：存储协议用 surrealkv://，数据目录 ~/Library/Application Support/RecaplySense/db/）
- [x] 结论文档：`poc/RESULTS.md`（记录每项验证的通过/失败状态和最终决策）— 2026-04-06

**Phase 0 退出条件：**

- 所有 PoC 项有明确的通过/失败/替代方案结论
- 如有失败项，已在结论文档中记录替代决策
- 替代决策已评估对后续 Phase 的影响

---

### Phase 1 — 骨架搭建（2-3 天）

> **目标：** monorepo 基础设施 + 数据层就绪
> **验收标准：** `bun test` 通过，SurrealDB 能 CRUD

**Monorepo 初始化：**

- [ ] 初始化 root `package.json`（workspaces: `packages/*`）
- [ ] 配置 `turbo.json`
- [ ] 配置 root `.gitignore`、`.editorconfig`
- [ ] 配置 TypeScript（root `tsconfig.json` + packages 继承）
- [ ] 配置 Biome（`biome.json`）

**packages/shared：**

- [ ] Zod schema 定义：screenshot、entity、relationship、activity、chat、settings、events
- [ ] TypeScript 类型导出（`z.infer`）
- [ ] 常量定义：API 路径、默认配置值、系统限制
- [ ] 通用工具函数：date、validation
- [ ] Barrel export (`index.ts`)

**packages/engine 骨架：**

- [ ] `package.json` + 依赖安装
- [ ] `tsconfig.json`（strict: true + 全部严格选项）
- [ ] `bunfig.toml`
- [ ] `src/config/` — Zod 配置 schema + 加载器
- [ ] `src/utils/logger.ts` — Pino 根 logger 工厂
- [ ] `src/utils/errors.ts` — AppError 基类 + 子类错误层级
- [ ] `src/utils/timing.ts` — 性能计时器
- [ ] `src/events/` — EventBus（typed EventEmitter）+ 事件类型定义

**Storage 层：**

- [ ] `src/storage/database.ts` — SurrealDB 连接管理（基于 PoC 结论选择连接模式）
- [ ] `src/storage/schema/surreal.ts` — SurrealDB Schema 定义
- [ ] `src/storage/migrations/runner.ts` — 迁移执行器
- [ ] `src/storage/migrations/versions/001_initial.ts` — 初始表结构
  - 包含本次 Review 建议的新增字段：`embedding_model`、`schema_version`
- [ ] `src/storage/repositories/screenshotRepo.ts`
- [ ] `src/storage/repositories/entityRepo.ts`
- [ ] `src/storage/repositories/relationshipRepo.ts`
- [ ] `src/storage/repositories/settingsRepo.ts`
- [ ] `withTransaction` 辅助函数
- [ ] 测试：Repository 单元测试 + SurrealDB 集成测试（内存模式）

---

### Phase 2 — 数据写入通路（3-5 天）

> **目标：** Collector → Engine 的完整数据写入链路
> **验收标准：** `curl POST /ingest/screenshot` → DB 中有完整记录（含 embedding + entity + 关系边）

**API 基础：**

- [ ] `src/api/router.ts` — Hono 路由总入口
- [ ] `src/api/middleware/errorHandler.ts` — 统一错误处理
- [ ] `src/api/middleware/rateLimit.ts` — 请求限流（内存计数器）
- [ ] `src/api/middleware/requestLogger.ts` — 请求日志中间件
- [ ] `src/api/routes/health.ts` — `GET /health`
- [ ] `src/api/routes/ingest.ts` — `POST /ingest/screenshot` + `POST /ingest/batch`
- [ ] `src/api/routes/collector.ts` — `GET /collector/config` + `POST /collector/heartbeat`

**Ingestion Pipeline：**

- [ ] `src/ingestion/queue.ts` — 任务队列（启动时恢复 queued/processing 记录）
- [ ] `src/ingestion/pipeline.ts` — 摄入管线编排
- [ ] `src/ingestion/processors/deduplicator.ts` — capture_id 幂等去重
- [ ] `src/ingestion/processors/chineseTokenizer.ts` — 中文分词（基于 PoC-11 结论选择方案）
- [ ] `src/ingestion/processors/entityExtractor.ts` — NER Level 1（本地规则匹配）
- [ ] `src/ingestion/processors/embedder.ts` — 向量化处理器（批量 API）
- [ ] `src/ingestion/processors/contextEnricher.ts` — 上下文增强
- [ ] 重试与死信机制（3 次重试 → dead_letter）

**AI Provider：**

- [ ] `src/ai/providers.ts` — AI SDK provider 工厂
- [ ] `src/ai/embedding/remote.ts` — 远程 Embedding API（SiliconFlow BGE-M3）
- [ ] `src/ai/ner/patterns.ts` — NER 本地规则（正则 + 字典）
- [ ] `src/ai/ner/extractor.ts` — NER 编排（Level 1 本地 + Level 2 云端降级）

**EventBus 集成：**

- [ ] Ingestion 完成后 emit `screenshot:ingested`
- [ ] Ingestion 写入时设置 `vision_pending = true`（持久化 Vision 触发状态）

**服务入口：**

- [ ] `src/index.ts` — Bun 服务入口（组装依赖、启动 HTTP server）
- [ ] Graceful shutdown（SIGTERM/SIGINT 处理）

**测试：**

- [ ] Ingestion Pipeline 单元测试（mock AI provider + mock DB）
- [ ] API 集成测试（Hono test client + 内存 SurrealDB）

---

### Phase 3 — 数据查询通路（3-5 天）

> **目标：** 搜索引擎 + 时间线 + 实体查询 API
> **验收标准：** 能搜索到 Phase 2 写入的数据，各接口性能达标

**Search Engine：**

- [ ] `src/search/engine.ts` — 搜索引擎主入口
- [ ] `src/search/strategies/vectorSearch.ts` — 向量语义搜索
- [ ] `src/search/strategies/fullTextSearch.ts` — 全文搜索（英文 + 中文预分词）
- [ ] `src/search/strategies/graphSearch.ts` — 图关系搜索
- [ ] `src/search/strategies/timeRangeSearch.ts` — 时间范围搜索
- [ ] `src/search/strategies/hybridSearch.ts` — 混合搜索（3 策略并行 + RRF 融合）
- [ ] `src/search/ranker.ts` — 结果排序器

**API 路由：**

- [ ] `src/api/routes/search.ts` — `POST /search` + `POST /search/suggest`
- [ ] `src/api/routes/timeline.ts` — `GET /timeline` + `GET /timeline/summary`
- [ ] `src/api/routes/entities.ts` — `GET /entities` + `GET /entities/:id` + `GET /entities/:id/graph`
- [ ] `src/api/routes/screenshots.ts` — `GET /screenshots/:id` + `/image` + `/thumbnail`
- [ ] `src/api/routes/stats.ts` — `GET /stats/overview` + `GET /stats/app-usage`

**WebSocket：**

- [ ] `src/api/ws/handler.ts` — WebSocket 连接管理（ping/pong、request_id 关联）
- [ ] `src/api/ws/events.ts` — WS 事件订阅（EventBus → WS 推送）

**Storage 补充：**

- [ ] `src/storage/repositories/embeddingRepo.ts`
- [ ] `src/storage/repositories/activitySegmentRepo.ts`
- [ ] `src/storage/repositories/chatHistoryRepo.ts`

**测试：**

- [ ] Search 各策略单元测试
- [ ] Hybrid 搜索集成测试（真实 SurrealDB 内存模式 + 测试数据）
- [ ] API E2E 测试（搜索 + 时间线）
- [ ] 性能基准测试（向量搜索 < 100ms、混合搜索 < 500ms）

---

### Phase 4 — AI 智能层（3-5 天）

> **目标：** Vision LLM + AI Agent + MCP Server + 定时任务
> **验收标准：** 能通过 chat 自然语言查询屏幕记录；MCP Server 可被 Claude Desktop 调用

**Vision 模块：**

- [ ] `src/vision/sessionManager.ts` — App Session 管理（开始/结束/flush）
  - 包含 session 上下文持久化（pending segment 记录）
- [ ] `src/vision/frameSelector.ts` — OCR 文本去重 + 代表帧选择（≤8 帧）
- [ ] `src/vision/visionAnalyzer.ts` — Vision LLM 调用 + 结构化输出
- [ ] `src/vision/segmentWriter.ts` — activity_segment 写入
- [ ] EventBus 订阅 `screenshot:ingested` + 定时扫描 `vision_pending = true` 双通道
- [ ] Vision LLM 失败降级（3 次失败后跳过）

**Agent 模块：**

- [ ] `src/agent/agent.ts` — AI SDK streamText + tools 主入口
- [ ] `src/agent/tools/vectorSearchTool.ts`
- [ ] `src/agent/tools/fullTextSearchTool.ts`
- [ ] `src/agent/tools/graphQueryTool.ts`
- [ ] `src/agent/tools/timeFilterTool.ts`
- [ ] `src/agent/tools/entityLookupTool.ts`
- [ ] `src/agent/tools/screenshotTool.ts`
- [ ] `src/agent/tools/activitySearchTool.ts`
- [ ] `src/agent/tools/statsTool.ts`
- [ ] `src/agent/prompts/systemPrompt.ts`
- [ ] `src/agent/memory/conversationMemory.ts`
- [ ] Agent 安全护栏（maxSteps=10、maxTokens=4096、超时限制）

**Chat API：**

- [ ] `src/api/routes/chat.ts` — `POST /chat/sessions` + `GET /chat/sessions` + `POST /chat/sessions/:id/messages`
- [ ] WebSocket chat:send → chat:chunk 流式回复

**MCP Server：**

- [ ] `src/mcp/server.ts` — MCP Server 入口
- [ ] `src/mcp/tools/searchMemory.ts`
- [ ] `src/mcp/tools/browseTimeline.ts`
- [ ] `src/mcp/tools/lookupEntity.ts`
- [ ] `src/mcp/tools/getEntityGraph.ts`
- [ ] `src/mcp/tools/getScreenshotDetail.ts`
- [ ] `src/mcp/tools/getActivitySummary.ts`
- [ ] `src/mcp/resources/todaySummary.ts`
- [ ] `src/mcp/resources/recentScreenshots.ts`
- [ ] `src/mcp/resources/frequentEntities.ts`
- [ ] `src/mcp/resources/statsOverview.ts`
- [ ] `src/mcp/transport/stdio.ts`（含 Engine 健康检查逻辑）
- [ ] `src/mcp/transport/streamableHttp.ts`

**定时任务：**

- [ ] `src/scheduler/registry.ts` — 任务注册表
- [ ] `src/scheduler/tasks/screenshotCleanup.ts`
- [ ] `src/scheduler/tasks/backupDaily.ts`
- [ ] `src/scheduler/tasks/deadLetterScan.ts`
- [ ] `src/scheduler/tasks/visionRetry.ts`

**其他 API：**

- [ ] `src/api/routes/settings.ts` — `GET/PATCH /settings`
- [ ] `src/api/routes/backup.ts` — `POST /backup/trigger` + `GET /backup/status`
- [ ] `src/api/routes/export.ts` — `POST /export`
- [ ] `src/api/routes/ai-usage.ts` — `GET /stats/ai-usage`

**测试：**

- [ ] Agent 工具调用测试（mock LLM）
- [ ] Vision 帧选择算法测试
- [ ] MCP Server 集成测试
- [ ] Chat 流式回复 E2E 测试

---

### Phase 5 — Collector（5-7 天）

> **目标：** Swift 屏幕采集守护进程
> **验收标准：** 启动 Collector 后自动截图 → OCR → POST 到 Engine → 数据入库

**CaptureEngine：**

- [ ] `ScreenRecorder.swift` — ScreenCaptureKit 封装
- [ ] `ChangeDetector.swift` — 帧差异检测（像素级降采样比较）
- [ ] `CaptureScheduler.swift` — 截图调度（2s 活跃 / 10s 空闲自适应）
- [ ] `DisplayManager.swift` — 多显示器管理

**Privacy：**

- [ ] `PrivacyFilter.swift` — 隐私过滤器
- [ ] `AppExcluder.swift` — 应用排除列表
- [ ] `ContentDetector.swift` — 敏感内容检测（密码框等）

**Storage：**

- [ ] `ScreenshotWriter.swift` — WebP 压缩写入
- [ ] `FileNaming.swift` — 文件命名规则（HHMMSS_hash.webp）
- [ ] `StorageManager.swift` — 磁盘空间管理

**Context：**

- [ ] `ActiveAppDetector.swift` — 当前活跃应用检测
- [ ] `WindowTitleReader.swift` — 窗口标题读取
- [ ] `TimezoneCapture.swift` — IANA 时区采集
- [ ] `ContextCollector.swift` — 上下文信息聚合

**OCR：**

- [ ] `VisionOCR.swift` — Apple Vision 文字识别
- [ ] `OCRProcessor.swift` — OCR 编排（截图 → 文字）

**Network：**

- [ ] `EngineClient.swift` — 与 Engine 通信（POST screenshot + batch + heartbeat）
- [ ] `HealthCheck.swift` — Engine 健康检测 + 指数退避重连

**离线缓冲：**

- [ ] SQLite 缓冲文件管理（10 万条 / 500MB 上限）
- [ ] Engine 恢复后批量回放（含节流策略，参考 §3.2 建议）

**Config：**

- [ ] `CollectorConfig.swift` — 采集器配置（从 Engine 轮询获取）

**main.swift：**

- [ ] Daemon 入口 + SIGTERM 优雅关停
- [ ] Package.swift 配置

**联调测试：**

- [ ] Collector → Engine 全链路联调
- [ ] 变化检测准确性验证（5% 阈值测试）
- [ ] OCR 质量验证
- [ ] 离线缓冲 → 回放测试
- [ ] 性能验证（稳态 CPU < 5%，内存 < 100MB）

---

### Phase 6 — Desktop UI（持续迭代）

> **目标：** SwiftUI macOS 菜单栏应用
> **验收标准：** 完整的用户体验——安装 → 引导 → 录制 → 搜索 → 对话

**App 基础：**

- [ ] `RecaplySenseApp.swift` — App 入口 + 生命周期
- [ ] `AppDelegate.swift` — NSApplicationDelegate
- [ ] `ProcessManager.swift` — LaunchAgent 注册（SMAppService）

**Onboarding：**

- [ ] `OnboardingView.swift` — 首次使用引导
  - 屏幕录制权限请求
  - 辅助功能权限（可选）
  - AI Provider 选择 + API Key 输入
  - LaunchAgent 注册

**核心视图：**

- [ ] `MenuBarView.swift` — 菜单栏常驻图标
- [ ] `QuickSearchView.swift` — 快捷搜索弹窗
- [ ] `TimelineView.swift` — 时间线主视图
- [ ] `ScreenshotCard.swift` — 截图卡片组件
- [ ] `TimelineFilter.swift` — 过滤器
- [ ] `SearchView.swift` — 搜索主视图
- [ ] `SearchResultView.swift` — 搜索结果
- [ ] `ChatView.swift` — AI 对话界面
- [ ] `MessageBubble.swift` — 消息气泡

**设置：**

- [ ] `SettingsView.swift` — 设置主视图
- [ ] `PrivacySettings.swift` — 隐私控制
- [ ] `StorageSettings.swift` — 存储管理
- [ ] `AISettings.swift` — AI 模型设置

**Services：**

- [ ] `APIClient.swift` — HTTP REST 客户端
- [ ] `WebSocketClient.swift` — WS 实时连接（含重连逻辑）
- [ ] `KeyboardShortcut.swift` — 全局快捷键

**共享类型：**

- [ ] `shared/swift/SharedTypes.swift`（手动维护 or quicktype 自动生成，基于 §3.4 决策）

---

## 六、风险与任务总结矩阵

| 分类      | 项目                                              | 优先级 | 对应 Phase        | 状态 |
| --------- | ------------------------------------------------- | ------ | ----------------- | ---- |
| 🚨 阻塞性 | SurrealDB 3.x PoC 验证（10 项）                   | 最高   | Phase 0           | [x]  |
| 🚨 阻塞性 | jieba-wasm + Bun 兼容性验证                       | 最高   | Phase 0           | [x]  |
| ⚠️ 高     | 时间语义统一（UTC + 本地时间派生规则）            | 高     | Phase 1 schema    | [ ]  |
| ⚠️ 高     | 搜索分页语义冻结（统一流 or 分通道）              | 高     | Phase 3 开工前    | [ ]  |
| ⚠️ 高     | activity_segment 实体双写收敛（图边 vs 内联数组） | 高     | Phase 1 schema    | [ ]  |
| ⚠️ 高     | 内存预算修正（基础进程 vs 含向量索引）            | 高     | Phase 1 开工前    | [ ]  |
| ⚠️ 高     | Vision Session 持久化方案                         | 高     | Phase 4 设计时    | [ ]  |
| ⚠️ 高     | MCP stdio 启动时 Engine 健康检查                  | 高     | Phase 4           | [ ]  |
| ⚠️ 中     | ProcessManager.swift 改名为 LaunchAgentManager    | 中     | Phase 6           | [ ]  |
| ⚠️ 中     | 文档细节对齐（lockfile、workspaces、目录命名）    | 中     | Phase 1 骨架      | [ ]  |
| ⚠️ 中     | CI 加入集成测试                                   | 中     | Phase 3 之后      | [ ]  |
| ⚠️ 中     | Collector 批量回放节流策略                        | 中     | Phase 5           | [ ]  |
| ⚠️ 中     | embedding_model 版本字段                          | 中     | Phase 1 schema    | [ ]  |
| ⚠️ 中     | activity_segment schema_version                   | 中     | Phase 1 schema    | [ ]  |
| 💡 低     | 简化 Collector Token → User-Agent                 | 低     | Phase 5           | [ ]  |
| 💡 低     | 推迟 Swift 类型自动生成                           | 低     | Phase 5           | [ ]  |
| 💡 低     | 截图清理后 segment 预览缓存                       | 低     | Phase 4 scheduler | [ ]  |

---

## 附录 A: 实现过程中发现的新问题

> 各 Agent 在实现过程中发现的新问题记录在此。格式：
>
> ### A-序号}: {问题标题}
>
> - **发现阶段：** Phase X
> - **严重程度：** 🚨/⚠️/💡
> - **描述：** ...
> - **建议方案：** ...
> - **状态：** [ ] 待解决 / [x] 已解决

（暂无）

---

## 附录 B: 架构变更日志

> 实现过程中对 `docs/architecture/` 文档的变更记录在此。格式：
>
> | 日期 | 变更文件 | 变更摘要 | 原因 |
> | ---- | -------- | -------- | ---- |

| 日期 | 变更文件 | 变更摘要 | 原因 |
| ---- | -------- | -------- | ---- |
| 2026-04-06 | data-models.md | screenshot 表加 `embedding_model`, `image_embedding`, `image_embedding_model` 字段 | Embedding 模型迁移追踪 + 多模态预留 |
| 2026-04-06 | data-models.md | entity 表加 `embedding_model` 字段 | Embedding 模型迁移追踪 |
| 2026-04-06 | data-models.md | activity_segment 表加 `embedding_model`, `schema_version`, `timezone`, `local_date` 字段 | 模型迁移 + Vision prompt 版本 + 本地时间聚合 |
| 2026-04-06 | data-models.md | screenshot.path 改为相对路径，新增 §7 文件存储设计约定（FileStorage 接口 + StorageConfig） | 支持存储位置迁移（NAS/S3） |
| 2026-04-06 | operational-design.md | 清理策略不再清空 ocr_text，仅清空 embedding 和 image_embedding | 保留 Embedding 模型迁移能力 |

---

## 附录 C: 设计预留清单（Phase 0 讨论产出）

> Phase 0 PoC 验证和产品化讨论中确认的预留项，确保未来扩展性：

### C.1 Schema 预留字段

| 字段 | 表 | 类型 | 目的 | 文档位置 |
|------|-----|------|------|----------|
| `embedding_model` | screenshot, entity, activity_segment | `string DEFAULT 'bge-m3-v1'` | Embedding 模型迁移追踪 | data-models.md |
| `schema_version` | activity_segment | `int DEFAULT 1` | Vision prompt 版本追踪 | data-models.md |
| `image_embedding` | screenshot | `option<array<float>>` | 多模态图片向量（暂不写入，不建索引） | data-models.md |
| `image_embedding_model` | screenshot | `option<string>` | 多模态模型版本 | data-models.md |
| `timezone` | activity_segment | `string` | 本地时间聚合 | data-models.md |
| `local_date` | activity_segment | `string` | 按天查询 | data-models.md |

### C.2 存储设计约定

| 约定 | 说明 | 文档位置 |
|------|------|----------|
| DB 中图片路径存**相对路径** | `2026/04/06/143025_a1b2.webp`，换存储位置只改基目录 | data-models.md §7.1 |
| `FileStorage` 接口抽象 | 先只实现 `LocalFileStorage`，预留 NAS/S3 接口 | data-models.md §7.2 |
| `screenshots_dir` 可配置 | 默认 `~/Library/.../screenshots/`，支持指向 NAS 挂载点 | data-models.md §7.3 |

### C.3 接口设计预留（Phase 2 实现时）

| 预留 | 说明 |
|------|------|
| `EmbeddingProvider.embedImage?()` | 可选方法，当前不实现，为多模态 embedding 预留 |
| Ingestion Pipeline 插件式 processor | 每步骤独立，方便未来新增 image embedding processor |

### C.4 搜索引擎预留（Phase 3 实现时）

| 预留 | 说明 |
|------|------|
| Search strategy 列表可扩展 | 留注释标记 `// 未来：imageVectorSearch` |
| Reranker 槽位 | ranker.ts 结构允许插入 rerank 步骤 |

### C.5 清理策略约束

| 约束 | 说明 | 文档位置 |
|------|------|----------|
| 清理时**不删 ocr_text** | 保留 Embedding 模型重新编码能力 | operational-design.md §9.2 |
| 截图 WebP 默认保留至用户配置的天数 | 为 image embedding 批处理留窗口（默认永不删除） | operational-design.md §9.1 |

### C.6 运行时架构决策

| 决策 | 结论 | 来源 |
|------|------|------|
| SurrealDB 模式 | **Standalone + WebSocket 连接** | PoC-12 |
| 存储协议 | `surrealkv://`，数据目录 `~/Library/.../RecaplySense/db/` | PoC-12 |
| Engine/DB 可远程部署 | 改连接地址即可，架构天然支持 | Phase 0 讨论 |
| Embedding 模型迁移 | 可行，只需保留原始文本 + embedding_model 字段 | Phase 0 讨论 |
