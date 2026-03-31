# Recaply Sense — Operational Design

> Version: 0.1.0 | Last Updated: 2026-04-01

本文档定义了系统在运行阶段的关键设计：数据备份、数据库迁移、错误处理、
监控、安全模型、截图清理等。与架构设计文档互补，关注 "Day 2" 运维能力。

---

## 1. 数据备份与导出策略

### 1.1 备份架构

```
Tier 1: 自动每日备份（本地）
──────────────────────────
• 每天凌晨 3:00（用户可配置 cron 表达式）执行 surreal export
• 导出到 ~/Library/.../RecaplySense/backups/
• 文件名: backup_2026-03-31_030000.surql.zst (zstd 压缩)
• 保留策略: 最近 7 个日备份 + 4 个周备份（每周日），更早的自动清理
• 截图目录仅记录文件清单（清单 vs 全量复制，节省空间）

Tier 2: 手动完整备份（可导出到外部）
────────────────────────────────────
• 用户在设置页面点击"导出完整备份"
• 执行: surreal export + 打包 screenshots/ 目录
• 输出: RecaplySense-backup-2026-03-31.tar.zst
• 支持选择目标路径（NAS/外接硬盘/本地目录）
• 一致性保证：导出时记录最新 screenshot.timestamp，
  截图目录仅包含该时间点之前的文件

Tier 3: 数据导出（用户主权）
────────────────────────────
• "导出我的数据" 功能（设置页面）
• 导出为人类可读格式：
  - screenshots/         → 原始 WebP 文件
  - metadata.jsonl       → 每行一条截图元数据 (JSON Lines)
  - entities.json        → 所有实体及关系
  - chat_history.json    → 对话历史
  - activity_segments.json → 活动摘要
• 不含向量/索引（可从原文重建）
```

### 1.2 实现要点

```typescript
// engine/src/storage/backup.ts

interface BackupConfig {
  enabled: boolean;
  schedule: string; // cron 表达式, 默认 "0 3 * * *"
  retentionDailyCount: number; // 默认 7
  retentionWeeklyCount: number; // 默认 4
  backupDir: string; // 默认 ~/Library/.../RecaplySense/backups/
}

// 一致性保证流程：
// 1. 备份前暂停 ingestion queue（不暂停 collector，截图仍写磁盘）
// 2. 记录当前 max(screenshot.timestamp) 作为一致性水位线
// 3. 执行 surreal export
// 4. 恢复 ingestion queue
// 5. 截图文件清单仅包含水位线之前的文件
```

### 1.3 API

```
POST /api/v1/backup/trigger    — 手动触发备份
GET  /api/v1/backup/status     — 查询备份状态/历史
POST /api/v1/export            — 导出用户数据（人类可读格式）
```

---

## 2. 数据库迁移策略

### 2.1 迁移框架

```
核心机制：
• 每个迁移是一个 .ts 文件，包含 up() 方法
• migration_history 表记录已执行的迁移（见 data-models.md）
• Engine 启动时自动检查并执行待执行的迁移
• 迁移在事务中执行，失败自动回滚该次迁移

版本命名：
  001_initial_schema.ts
  002_add_activity_segment.ts
  003_add_ocr_tokenized_field.ts
  004_screenshot_status_enum.ts
  ...

大数据量迁移策略：
• 预估影响行数，超过 10K 行的迁移标记为 batch migration
• batch migration 分批执行（每批 1000 条），带进度上报
• 耗时迁移前自动执行 surreal export 创建回滚点

SurrealDB Breaking Change 应对：
• pinned version: package.json 锁定 SurrealDB 版本
• 升级前: 在测试 DB 上运行全部迁移 + integration tests
• Repository 抽象层已提供隔离，查询语法变更只影响 repo 层
```

### 2.2 实现结构

```typescript
// engine/src/storage/migrations/runner.ts

interface Migration {
  version: number;
  name: string;
  up(db: SurrealDB): Promise<void>;
  batch?: boolean; // 标记是否为大数据量迁移
}

// Engine 启动流程:
// 1. 读取 migration_history 表获取已执行版本号
// 2. 扫描 migrations/versions/ 目录获取所有迁移文件
// 3. 找到未执行的迁移，按版本号顺序执行
// 4. 每个迁移执行后记录到 migration_history（含耗时）
// 5. 任何失败 → 记录错误日志 + 阻止 Engine 启动
```

### 2.3 不支持自动回滚

建议不实现 `down()` 自动回滚，原因：

- 数据库 down migration 很难做到无损（删列丢数据）
- 个人项目场景下，备份恢复比代码级回滚更可靠
- 实际回滚操作：恢复备份 + 部署旧版本

---

## 3. 大文本 Embedding 策略

### 3.1 问题

BGE-M3 支持最大 **8192 tokens** 输入。大部分截图 OCR 文本 < 2000 字符无问题，
但代码编辑器/终端/长文档可能产生 5000-15000 字符，超出模型上下文窗口。

### 3.2 方案：truncate-first + activity_segment 补偿

```
逐帧 Embedding（Ingestion Pipeline）:
  1. 对 ocr_text 做长度检查
  2. ≤ 6000 字符 → 直接 embedding（留 buffer 给 tokenizer）
  3. > 6000 字符 → 智能截断:
     a. 取前 3000 字符 + 后 3000 字符（首尾保留）
     b. 用分隔符 " [...] " 连接
     c. 对拼接结果做 embedding
  4. 在 screenshot.ocr_truncated = true 标记

为什么首尾保留？
  • 代码编辑器: 首部=文件名/函数签名，尾部=当前编辑区域
  • 终端输出: 首部=命令，尾部=最新输出
  • 长文档: 首部=标题/章节名，尾部=当前阅读位置

activity_segment 补偿:
  • activity_segment.summary 由 Vision LLM 生成（100-200 字）
  • 对 summary 做 embedding，作为该时间段的"高质量"向量
  • 搜索时: screenshot 向量粗筛 + activity_segment 向量语义补偿

全文搜索兜底:
  • ocr_text 原文完整存储（不截断），FTS 索引覆盖全部文本
  • 向量搜索 miss 的长文本内容，全文搜索可以兜底
  • hybrid 策略天然适合这种场景
```

---

## 4. 实体去重与合并策略

### 4.1 三层去重

```
第一层：写入时去重（Ingestion Pipeline）
────────────────────────────────────────
NER 提取出实体后，在写入前检查：
  1. 精确匹配: 按 (type, name) 查找已有实体
  2. 别名匹配: 按 (type, aliases CONTAINS name) 查找
  3. 模糊匹配: 归一化后比较
     - 移除空格/下划线/连字符
     - 统一大小写
     - 中文简繁转换
  4. 匹配到 → 复用已有实体 ID，更新 last_seen/frequency
  5. 未匹配 → 创建新实体

第二层：异步候选发现（周期任务）
──────────────────────────────
定期扫描 entity 表，发现可能的重复对：
  1. 名称相似度 > 0.8 (Jaro-Winkler) 的同类型实体
  2. 向量余弦相似度 > 0.95 的同类型实体
  3. 结果写入 entity_merge_candidate 表（见 data-models.md）

第三层：合并执行
────────────────
  自动合并: 高置信度（相似度 > 0.95 + 名称差异仅为大小写/空格）
  手动确认: 低置信度，通过 Frontend 设置页面展示候选对

合并操作：
  1. 保留 frequency 更高的实体作为主实体
  2. 将被合并实体的 name 加入主实体的 aliases
  3. UPDATE appeared_in SET in = 主实体ID WHERE in = 被合并ID
  4. UPDATE related_to 的 in/out 字段
  5. DELETE 被合并实体
```

---

## 5. capture_id 安全设计

### 5.1 改进后的生成方式

```
旧: capture_id = sha256(path + timestamp)
新: capture_id = sha256(path + timestamp + file_size + machine_id)

其中:
  path       = 截图文件的绝对路径
  timestamp  = ISO 8601 时间戳（毫秒精度）
  file_size  = 文件大小（bytes）
  machine_id = IOPlatformUUID (macOS 硬件唯一标识，Collector 启动时读取一次缓存)

优势：
  • file_size 消除"不同内容但同路径同时间"的碰撞
  • machine_id 消除多设备场景（未来支持同步时）的碰撞
  • 保持确定性（同一截图重复提交仍得到相同 ID，幂等不受影响）
```

---

## 6. Collector 离线缓冲

### 6.1 方案

```
Engine 不可达时的数据缓冲
═══════════════════════════

正常流程:
  Collector → HTTP POST → Engine ✅

Engine 不可达时:
  1. HealthCheck 检测 Engine 不可用（3 次连续失败）
  2. 进入离线模式，截图仍然继续写磁盘
  3. 截图元数据写入本地 SQLite 缓冲文件：
     ~/Library/.../RecaplySense/collector_buffer.sqlite
  4. 缓冲上限: 100,000 条记录 或 500MB（先到为准）
     达到上限后仅保留截图文件，丢弃最旧的缓冲元数据

Engine 恢复后:
  1. HealthCheck 检测 Engine 恢复
  2. 读取 SQLite 缓冲，按 timestamp 排序
  3. 使用 POST /api/v1/ingest/batch 批量提交（每批 100 条，批间 500ms）
  4. 成功提交的记录从 SQLite 中删除
  5. 全部回放完成后关闭 SQLite 文件

重连策略:
  • 指数退避: 1s → 2s → 4s → 8s → ... → 最大 60s
  • 检测恢复后立即切回正常模式
```

### 6.2 为什么用 SQLite 而不是 SurrealDB

SurrealDB 以嵌入式模式运行在 **Engine 进程**内。当 Engine 不可达时，
SurrealDB 也不可用。Collector 需要一个独立于 Engine 的本地存储。

| 方案                       | 优势                                        | 劣势                                         |
| -------------------------- | ------------------------------------------- | -------------------------------------------- |
| **SQLite** ✅              | Swift 原生支持 (系统库)；原子写入；崩溃安全 | 额外依赖（实际是系统自带）                   |
| JSONL 文件                 | 最简单                                      | 崩溃时可能写到一半损坏；排序不便             |
| Collector 也嵌入 SurrealDB | 与 Engine 一致                              | 引入 Rust binary 依赖，仅为临时缓冲 overkill |
| 纯内存                     | 零 I/O                                      | Collector 崩溃即丢失                         |

SQLite 在这里是 **Collector 进程的临时缓冲区**，Engine 恢复后数据仍然流入 SurrealDB。

---

## 7. Ingestion 错误重试与死信策略

### 7.1 重试机制

```
Ingestion Pipeline 重试:
  • 每个 screenshot 最多 3 次重试
  • 间隔: 5s → 30s → 300s (指数退避)
  • 重试仅针对可恢复错误（网络超时、临时 DB 错误）
  • 不可恢复错误（文件不存在、数据校验失败）直接进入 dead letter

数据模型变更:
  screenshot.processed: bool 升级为 screenshot.status: string 枚举
  新增字段: retry_count, last_error（见 data-models.md）

状态流转:
  queued → processing → done
                     → (失败, retry_count < 3) → queued (等待重试)
                     → (失败, retry_count >= 3) → dead_letter
```

### 7.2 Dead Letter 处理

```
• 3 次重试后标记为 dead_letter
• 记录 last_error 到 screenshot.last_error
• 通过 WS 推送告警到 Frontend
• 设置页面展示 dead letter 列表，支持手动重试
```

### 7.3 Vision LLM 失败降级

```
• LLM 调用失败 → activity_segment 不生成，不阻塞 Ingestion
• 标记对应的 screenshot 帧为 vision_pending = true（见 data-models.md screenshot 表定义）
• 下次 session flush 或定期任务重新尝试
• 3 次失败后跳过该 segment，仅依赖 OCR 层数据
```

### 7.4 启动恢复

```
• Engine 启动时扫描 status = 'queued' | 'processing' 的记录
• 重置为 'queued' 并重新入队
• dead_letter 保持不变，需要用户手动触发
```

---

## 8. WebSocket 重连策略

### 8.1 重连参数

```
• 初始延迟: 1s
• 最大延迟: 30s
• 退避因子: 2x
• 加抖动: ±20% 随机偏移（避免多客户端同时重连）
• 最大重试: 无限（直到成功或用户关闭 App）
```

### 8.2 心跳检测

```
• 客户端每 30s 发送 ping
• 服务端 5s 内应回复 pong
• 2 次 ping 无 pong → 判定连接断开，主动关闭并重连
```

### 8.3 消息可靠性决策

```
• screenshot:new / ingestion:progress → 不保证（可丢失）
  理由: 下次打开 timeline 就能看到最新截图，不依赖推送
• chat:chunk → 不保证（断连后放弃当前回复，用户可重新提问）
• collector:status → 不保证（重连后主动 GET 最新状态）

重连后恢复:
  重连成功后，Frontend 主动拉取最新状态：
    GET /health          → collector 状态
    GET /timeline?date=today → 最新截图
    GET /ingest/status   → 管线状态
  这比实现消息队列保证 at-least-once 简单得多。
```

---

## 9. 截图保留与清理策略

### 9.1 保留策略（用户可配置）

```
• auto_delete_after_days: null | number
  null → 永不自动删除（默认）
  number → 超过 N 天的截图被标记为可清理

• max_storage_gb: number (默认 500)
  磁盘剩余 < 10GB 或截图目录超过上限时触发强制清理
```

### 9.2 清理执行流程

```
1. 查询满足清理条件的 screenshot IDs (按时间最旧优先)
2. 批量处理（每批 500 条）：
   a. 删除截图文件 (WebP)
   b. 删除缩略图缓存
   c. 删除 appeared_in 关系边（WHERE out IN $ids）
   d. 删除 appeared_in_segment 关系边（WHERE out.screenshot_ids CONTAINSANY $ids 的 segment 相关）
   e. 从 activity_segment.screenshot_ids 中移除引用
   f. 清空 screenshot.embedding 字段（释放向量存储空间）
      注意: SurrealDB HNSW 索引在 embedding 设为 NULL 后，
      该记录自动不参与向量搜索。无需手动重建索引，
      但搜索查询中仍建议加 WHERE embedding IS NOT NULL 做显式保护。
   g. 将 screenshot.purged = true
      （保留元数据但清除大字段: path, ocr_text, embedding）
3. 清理后更新 entity.frequency 计数
4. 删除不再被任何 screenshot 引用的 entity 记录
```

### 9.3 为什么保留 purged 元数据

```
• 时间线统计（"你在 2026 年 3 月用了 VS Code 180 小时"）
  仍需要 timestamp 和 app_name 数据
• purged 记录排除在搜索/向量查询之外（无 embedding）
```

### 9.4 磁盘空间不足降级

```
• 剩余 < 5GB: 降低截图质量（quality=30）
• 剩余 < 2GB: 暂停截图，通知用户
• 通过 WS 推送 storage_warning 事件
```

---

## 10. 向量存储规模化方案

### 10.1 内存估算

```
HNSW 索引内存占用（每个向量）：
  1024 维 × 4 bytes (float32) = 4 KB（向量本身）
  + HNSW 图结构开销 ≈ 1-2 KB（M=16 默认参数）
  ≈ 每个向量 5-6 KB

规模预估：
  100 万截图 → 约 5-6 GB 纯索引内存
  screenshot + entity + activity_segment 三表合计可能达 8-10 GB
```

### 10.2 三阶段策略

```
Phase 1 (0-50万截图, 前1-2年):
  • 维持 1024 维，HNSW 默认参数
  • 内存约 3-5 GB，macOS 16GB RAM 机型可承受
  • 无需特殊优化

Phase 2 (50-200万截图, 2-5年):
  • 评估 BGE-M3 截断前 512 维的质量损失（预期保留 ~95% 质量）
  • 内存减半
  • 或者：旧数据保持 1024 维不索引，仅 FTS 通道召回
    新数据使用 512 维，搜索时两路分别查询

Phase 3 (200万+ 截图, 5年+):
  • 评估 SurrealDB 向量搜索性能是否仍可接受
  • 备选: 将向量索引迁移到专用向量数据库 (Qdrant/Milvus)
    Repository 抽象层已提供隔离，迁移成本可控
  • 或者: 时间分区 — 仅索引最近 1 年的向量

当前建议: Phase 1 足够，先不过度优化。
在 storage/repositories/ 中预留 embedding 维度配置化能力。
```

---

## 11. Vision LLM 成本预警

### 11.1 追踪机制

```
• activity_segment 已有 llm_tokens_in / llm_tokens_out 字段
• Engine 汇总每日 token 用量和估算费用
• 新增设置项:
  vision_daily_budget_usd: number | null  (默认 1.0, null=无限制)
• 达到预算 80% → WS 推送 cost_warning
• 达到预算 100% → 暂停 Vision LLM 处理，仅保留 OCR 层
• 次日 0:00 自动重置计数器
```

### 11.2 API

```
GET /api/v1/stats/ai-usage  → 见 api-contracts.md §12
```

---

## 12. 监控与可观测性

### 12.1 日志

```
Pino 配置 pino-roll 日志轮转:
  • 依赖: pino-roll（需加入 packages/engine/package.json dependencies）
  • 按大小轮转: 50MB/文件
  • 保留: 最近 10 个日志文件
  • 路径: ~/Library/.../RecaplySense/logs/engine.log
  • 格式: JSON（便于 jq 查询诊断）
```

### 12.2 内部指标

```
内存中维护，通过 GET /api/v1/health 详细模式暴露：

  ingestion_queue_depth     — 当前队列深度
  ingestion_avg_latency_ms  — 最近 100 条平均处理时间
  search_avg_latency_ms     — 最近 100 次搜索平均耗时
  db_connection_status      — SurrealDB 连接状态
  memory_usage_mb           — 进程 RSS 内存
  screenshot_count_today    — 今日截图数
  dead_letter_count         — 死信队列数量
  vision_segments_today     — 今日处理的 activity_segment 数
  ai_tokens_today           — 今日 LLM token 消耗
```

### 12.3 崩溃报告

```
Engine:
  Bun 进程的 uncaughtException / unhandledRejection
  → 写入 error.log + 退出 (launchd 自动重启)

Collector:
  Swift 的 crash log 由 macOS 系统自动收集
  ~/Library/Logs/DiagnosticReports/
```

---

## 13. 安全信任模型

### 13.1 信任边界

```
• Engine API 仅绑定 localhost:21890，不暴露到网络
• 信任所有来自 localhost 的请求（无 API Key / Token）
• 任何本地进程理论上可访问 Engine API
• 这在单用户 macOS 桌面场景下是可接受的安全模型
```

### 13.2 威胁评估

```
恶意本地进程可以：读取所有截图数据、注入伪造截图、删除数据

缓解措施：
  • macOS 沙箱 + 文件权限 (700) + 用户教育
  • 运行时数据目录权限设为 700（仅当前用户可访问）
  • SurrealDB 数据目录同样 700

未来增强（非 MVP）：可选的 Bearer Token 认证
```

### 13.3 Collector 标识

```
Collector 的请求通过 X-Collector-Token header 标识。
Token 在首次安装时由 Frontend 生成并写入 Collector 和 Engine 的配置文件。
这不是安全措施（本地可被读取），而是用于：
  • 区分 Collector 流量与 Frontend 流量（日志/监控）
  • Rate limiting 对 Collector 豁免
```

---

## 14. Rate Limiting 规格

```
┌───────────────────────────┬────────────┬───────────────┐
│ API                       │ 限流       │ 备注          │
├───────────────────────────┼────────────┼───────────────┤
│ POST /ingest/screenshot   │ 60 次/分钟 │ Collector 豁免│
│ POST /ingest/batch        │ 5 次/分钟  │               │
│ POST /search              │ 30 次/分钟 │               │
│ POST /chat/*/messages     │ 10 次/分钟 │ LLM 调用贵    │
│ GET  /timeline            │ 60 次/分钟 │               │
│ GET  /entities            │ 60 次/分钟 │               │
│ GET  /health              │ 无限制     │               │
│ WS messages               │ 30 条/分钟 │               │
└───────────────────────────┴────────────┴───────────────┘

策略: 固定窗口（1 分钟），内存计数器（无需 Redis）
Collector 豁免: 请求含 X-Collector-Token header
超限返回: 429 + Retry-After header
```

---

## 15. Graceful Shutdown 流程

### 15.1 Engine 优雅关停

```
收到 SIGTERM（launchd 停止服务）或 SIGINT（开发模式 Ctrl+C）时：

1. 停止接受新 HTTP 请求（Hono server.close()）
2. 等待进行中的请求完成（最大 10s 超时）
3. 关闭 WebSocket 连接（发送 close frame）
4. Flush ingestion queue：
   a. 停止消费新任务
   b. 等待当前处理中的 screenshot 完成（最大 30s）
   c. 队列中未处理的任务保持 status='queued'，下次启动恢复
5. Flush vision session：
   a. 当前活跃的 App Session 立即 flush（触发 segment 生成）
   b. 若 LLM 调用已发出，等待其返回（最大 15s）
6. 关闭 SurrealDB 连接（确保 WAL flush）
7. 关闭 MCP Server transport
8. 写入最终日志 "Engine shutdown complete"
9. process.exit(0)

总超时限制: 60s。超时后强制 exit(1)。
```

### 15.2 Collector 优雅关停

```
收到 SIGTERM 时：
1. 停止截图循环
2. 完成当前正在写入的截图文件
3. Flush 离线缓冲队列中已准备好的 HTTP 请求
4. 关闭 SQLite 缓冲文件
5. 退出

总超时限制: 10s。
```

---

## 16. 升级与热更新策略

### 16.1 升级流程

```
版本升级通过 App 自更新（Sparkle 框架）或手动替换 .app 实现。

升级步骤：
  1. 新版 RecaplySense.app 替换旧版（覆盖 /Applications/RecaplySense.app）
  2. 新版 App 首次启动时检测版本变化
  3. 重新注册 LaunchAgent（更新二进制路径和参数）
     SMAppService 重新 register → launchd 会 reload plist
  4. launchd 自动停止旧版 Engine/Collector 进程
  5. launchd 自动启动新版 Engine/Collector 进程
  6. Engine 启动时自动执行待执行的数据库迁移

不停机升级（不支持）:
  • Engine 是单实例嵌入式服务，不支持蓝绿部署
  • 升级期间约 5-10 秒服务不可用，Collector 自动进入离线缓冲模式
  • Engine 恢复后 Collector 回放缓冲数据

版本兼容性:
  • Collector 和 Engine 版本必须一致（同一 App Bundle 内）
  • 数据库迁移保证向前兼容（只有 up，无 down）
```

---

## 17. Collector Token 认证失败处理

```
X-Collector-Token 校验策略：

Engine 端:
  • 启动时从 config.json 或环境变量加载 expected_collector_token
  • 对 /api/v1/ingest/* 和 /api/v1/collector/* 路径的请求检查:
    X-Collector-Token header == expected_collector_token
  • Token 不匹配 → 返回 403 Forbidden
    { "error": { "code": "INVALID_COLLECTOR_TOKEN", "message": "..." } }
  • Token 缺失 → 视为 Frontend 请求，正常处理（但不享受 Rate Limit 豁免）

Collector 端:
  • Token 从 ~/Library/.../RecaplySense/config.json 读取
  • 收到 403 → 记录错误日志，进入离线缓冲模式
  • 不自动重试认证（避免日志风暴），等待用户检查配置

Token 生成:
  • 首次安装时 Frontend 生成 UUID v4 作为 token
  • 写入 config.json 的 collector_token 字段
  • Engine 和 Collector 从同一配置文件读取
```

---

## 18. 系统权限请求流程

```
macOS 权限请求时机与顺序：

  ┌──────────────────────────────────────────────────────────┐
  │         首次启动 Onboarding 流程                            │
  │                                                            │
  │  Step 1: 欢迎页面 + 功能介绍                                │
  │                                                            │
  │  Step 2: 请求屏幕录制权限 (Screen Recording)               │
  │    • 说明: "需要录制屏幕以记录你的数字生活"                   │
  │    • 触发: CGRequestScreenCaptureAccess()                   │
  │    • 拒绝处理: 展示引导页，提供"打开系统偏好设置"按钮          │
  │    • 权限检查: CGPreflightScreenCaptureAccess()             │
  │                                                            │
  │  Step 3: 请求辅助功能权限 (Accessibility) — 可选             │
  │    • 说明: "用于读取窗口标题以增强搜索体验"                    │
  │    • 若用户拒绝: 降级运行（无窗口标题数据）                    │
  │                                                            │
  │  Step 4: 选择 AI Provider                                  │
  │    • OpenAI / Anthropic / Ollama(本地)                      │
  │    • 输入 API Key（如选云端）                                │
  │                                                            │
  │  Step 5: 注册 LaunchAgent + 启动后台服务                    │
  │    • SMAppService.mainApp.register()                        │
  │                                                            │
  │  Step 6: 完成，进入主界面                                    │
  └──────────────────────────────────────────────────────────┘

后续权限丢失处理：
  • Collector 启动时检查屏幕录制权限
  • 权限丢失 → 通过 heartbeat 上报 Engine → WS 推送 Frontend
  • Frontend 弹出权限恢复引导

权限查询方式选择（TDR-017 补充）：
  • ScreenCaptureKit: SCShareableContent.current 会触发系统授权弹窗
  • CGPreflightScreenCaptureAccess(): 仅查询不弹窗，适用于权限检查
```

---

## 19. MCP Server 进程与 Lifecycle

```
MCP Server 的两种传输模式运行在不同的进程上下文中：

模式 1: stdio (Claude Desktop / Cursor)
────────────────────────────────────────
  • 由外部 AI 客户端（Claude Desktop / Cursor）启动 MCP Server 进程
  • 进程入口: recaply-engine --mcp-stdio
  • 独立于主 Engine 进程运行（但共享 SurrealDB 数据目录）
  • 连接方式: MCP Server 内部通过 HTTP 调用主 Engine API (localhost:21890)
    而非直接 import Engine 模块（避免两个进程竞争 SurrealDB 锁）
  • Lifecycle: 随外部 AI 客户端启停，无需 launchd 管理

模式 2: Streamable HTTP (端口 21891)
────────────────────────────────────
  • 在主 Engine 进程内作为第二个 HTTP 服务运行（与主 API 同进程）
  • 端口 21891 独立于主 API 的 21890
  • 两个 Hono 实例，共享 Engine 内部模块引用（search/storage）
  • Lifecycle: 随 Engine 启停

配置（engine config schema 扩展）:
  mcp: {
    stdio: { enabled: true },
    http: {
      enabled: true,
      port: 21891,
    }
  }

客户端配置示例（Claude Desktop mcp_servers.json）:
  {
    "recaply-sense": {
      "command": "/Applications/RecaplySense.app/Contents/MacOS/recaply-engine",
      "args": ["--mcp-stdio"]
    }
  }
```

---

## 20. Agent 安全护栏

### 20.1 Tool Calling 限制

```
AI SDK streamText 配置:
  • maxSteps: 10          — 最大工具调用轮次（防止无限循环）
  • maxTokens: 4096       — 单次回复最大 token 数
  • temperature: 0.3      — 降低随机性以保证一致性
  • 超过 maxSteps → 返回已收集的部分结果 + 告知用户"查询过于复杂"

工具调用超时:
  • 单个工具调用超时: 10s（搜索类），30s（AI 类）
  • 总对话超时: 120s
  • 超时 → 中断当前工具调用，用已有结果合成回答
```

### 20.2 Prompt 注入防护

```
• Agent system prompt 中明确角色约束（只能查询用户自己的屏幕数据）
• 用户输入不直接拼入 SurrealQL 查询（通过 Repository 参数化查询）
• MCP Tools 输入由 Zod schema 严格校验
```

---

## 21. Embedding 批量处理策略

### 21.1 Ingestion Pipeline 批量优化

```
单条 vs 批量:
  • 云端 API: 批量调用（每批 ≤ 32 条文本），显著减少 HTTP 开销和延迟
  • 本地 ONNX: 逐条处理（本地调用无网络开销，且内存受限）

批量调度:
  1. Ingestion queue 消费时按 batch_size=32 聚合
  2. 等待条件: 凑满 32 条 或 超过 2 秒（先到为准）
  3. 一次 HTTP 调用提交 32 条文本给 BGE-M3 API
  4. 批量写入 SurrealDB

性能预估（云端 API）:
  • 单条: ~200ms/次，32 条串行 = ~6.4s
  • 批量: ~300ms/次（32 条一起），加速 ~20x
  • 吞吐: ~100 条/秒 vs 单条 ~5 条/秒

实现:
  // engine/src/ingestion/processors/embedder.ts
  // batchEmbed(texts: string[], batchSize = 32): Promise<number[][]>
  // 内部按 batchSize 分组，调用 ai/embedding/remote.ts 的批量接口
```
