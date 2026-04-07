# Recaply Sense — REM Layer Design（知识沉淀层）

> Version: 0.1.0 | Last Updated: 2026-04-07

## 1. 设计理念

### 1.1 解决什么问题

Engine 的存储层保存的是**碎片化的原始数据**——每条截图的 OCR 文本、每个 NER 实体、每段活动摘要。这些数据适合精确搜索，但无法直接回答"我今天干了什么"这类高层问题。

REM（知识沉淀层）将原始数据**沉淀为可消费的知识**，分三个通道交付：

| 通道          | 面向       | 交互方式                                       |
| ------------- | ---------- | ---------------------------------------------- |
| **Routines**  | 用户       | 定时主动推送摘要/洞察到 UI                     |
| **Memory**    | Agent      | 持久上下文文件，对话时自动引用                 |
| **REM Cache** | 外部 Agent | MD 文件 + MCP Resources，供 Claude/Cursor 读取 |

### 1.2 核心原则

1. **零操作**：用户不需要管理知识库、打标签、整理文件。知识自动生成、按需呈现
2. **知识找人，不是人找知识**：Routines 主动推送，Agent 自动引用 Memory，用户不需要知道文件在哪
3. **MD 服务 Agent，UI 服务用户**：用户通过 Chat/Routines/时间线消费知识，外部 Agent 通过 MD 文件和 MCP 消费知识
4. **渐进式精确**：先有粗粒度的日摘要，随着数据积累逐步产出周/月回顾和行为洞察

### 1.3 竞品参考

| 产品           | 借鉴点                                                                                |
| -------------- | ------------------------------------------------------------------------------------- |
| **LittleBird** | Routines 定时推送模式、隐式知识（无知识库 UI）、Hummingbird 即时叠加层                |
| **Screenpipe** | Pipe 知识转化管线、Obsidian 日志同步、MCP Server 集成                                 |
| **OpenClaw**   | `SOUL.md` 持久记忆文件、Markdown 作为记忆底层格式、"对话中捕获、Dashboard 检索"双界面 |

---

## 2. 架构位置

REM 层是 Engine 的第 **9 个子模块** `rem/`，与 `vision/`、`search/` 平级：

> **命名说明**：REM 取自神经科学中的 REM 睡眠（Rapid Eye Movement Sleep）——大脑在 REM 阶段将短期记忆整合为长期记忆。类比此处：REM 层将碎片化的屏幕数据沉淀为结构化的知识。

```
依赖方向:
  api/mcp → agent → rem → ai + storage
                    ↗
  scheduler → rem
```

```
engine/src/
├── api/          # HTTP + WS 入口
├── mcp/          # MCP Server 入口
├── agent/        # AI 智能体
├── rem/          # ← 新增：REM 层（知识沉淀层）
│   ├── generators/
│   │   ├── daily-summary.ts      # 日摘要生成器
│   │   ├── weekly-summary.ts     # 周摘要生成器
│   │   └── types.ts              # 生成器共享类型
│   ├── memory/
│   │   ├── memory-manager.ts     # Memory 文件读写
│   │   └── memory-extractor.ts   # 从对话中提取记忆（inferred）
│   ├── export/
│   │   └── md-exporter.ts        # DB → MD 文件导出
│   └── index.ts                  # 模块入口
├── ingestion/    # 截图摄入管线
├── vision/       # Vision LLM
├── search/       # 搜索引擎
├── ai/           # AI Provider
└── storage/      # 数据层
```

---

## 3. Routines（定时推送）

### 3.1 概念

Routine 是一个**用户定义的定时知识请求**：

- **Prompt**：用户想获取什么信息（如 "总结我今天的工作"、"本周花最多时间的项目"）
- **Schedule**：推送频率（每日/每周/自定义 cron）
- **Delivery**：推送到 UI 通知 / 菜单栏 / WebSocket

### 3.2 内置 Routines

系统预置以下 Routines，用户可修改 prompt 或关闭：

| Routine    | 默认频率            | 默认 Prompt                                  | 输出                                      |
| ---------- | ------------------- | -------------------------------------------- | ----------------------------------------- |
| **日摘要** | 每日 23:55 本地时间 | "总结今天的屏幕活动，分时段列出主要工作内容" | `daily/YYYY-MM-DD.md` + DB 记录 + UI 通知 |
| **周回顾** | 每周日 20:00        | "回顾本周，分析时间分配、主要项目、行为模式" | `weekly/YYYY-WNN.md` + DB 记录 + UI 通知  |

### 3.3 自定义 Routines（后续迭代）

用户可通过设置界面创建自定义 Routine：

```json
{
  "name": "项目进度",
  "prompt": "总结 Recaply Sense 项目本周的开发进度和待办",
  "schedule": "0 18 * * 5",
  "enabled": true
}
```

### 3.4 Routine 执行流

```
Scheduler 触发
  → REM Generator 读取时间范围内的 activity_segments + entities
  → 构造 LLM prompt（系统 prompt + 数据上下文 + 用户 prompt）
  → 调用 AI Provider 生成摘要
  → 同时写入：
      1. rem_summary 表（结构化，可搜索）
      2. MD 文件（人类/Agent 可读）
      3. EventBus emit 'rem:generated'（触发 UI 通知 + WS 推送）
```

---

## 4. Memory（用户记忆）

### 4.1 概念

Memory 是一个**简单的持久化上下文文件** `memory.md`，类似 Claude Code 的 `MEMORY.md`：

- 系统和用户都可以往里写
- Agent 每次对话时读取作为额外上下文
- 不入库、不做复杂同步，就是一个文件

### 4.2 文件位置

```
~/Library/Application Support/RecaplySense/rem/memory.md
```

### 4.3 内容格式

自由格式，但推荐以下组织方式：

```markdown
# My Memory

## 偏好

- 我偏好使用 Bun 而不是 npm
- 所有文档使用中文
- 时区: Asia/Shanghai，位于杭州

## 事实

- Recaply Sense 数据库使用 SurrealDB 3.x
- 主力 IDE 是 VS Code
- Alice 是产品经理

## 决策

- [2026-04-06] 选择 standalone + WebSocket 模式连接 SurrealDB
- [2026-04-07] 知识层采用 Routines + Memory + REM Cache 三通道设计

## 笔记

- 周三下午的团队会议通常讨论技术方案
- 项目 X 下周五截止
```

### 4.4 Memory 的读写

| 操作           | 触发方式                    | 说明                                              |
| -------------- | --------------------------- | ------------------------------------------------- |
| **Agent 读**   | 每次 Chat 开始时            | 读取 `memory.md` 作为系统 prompt 的一部分         |
| **用户写**     | 手动编辑文件 / 通过设置界面 | 用户直接修改文件内容                              |
| **Agent 写**   | 用户在对话中说"记住这个"    | Agent 追加到 `memory.md`                          |
| **自动推断写** | Chat 结束后                 | 从对话中提取显著偏好/事实，标记 `[inferred]` 追加 |

### 4.5 自动推断规则

- 只提取高置信度的偏好和事实（由 LLM 判断）
- 追加时标记 `[inferred]`，用户可以删除不准确的推断
- 不重复已有条目（LLM 先检查 memory.md 现有内容）
- 推断频率限制：每次对话最多追加 2 条

---

## 5. REM Cache（知识缓存文件）

### 5.1 目录结构

```
~/Library/Application Support/RecaplySense/rem/
├── daily/
│   ├── 2026-04-07.md          # 日摘要（Routine 自动生成）
│   ├── 2026-04-06.md
│   └── ...
├── weekly/
│   ├── 2026-W15.md            # 周回顾（Routine 自动生成）
│   └── ...
└── memory.md                  # 用户记忆（§4）
```

### 5.2 文件生命周期

| 文件类型      | 生成时机           | 更新规则                                       | 保留策略           |
| ------------- | ------------------ | ---------------------------------------------- | ------------------ |
| `daily/*.md`  | 每日 Routine 触发  | 生成后不自动覆盖；用户编辑过的文件跳过重新生成 | 保留 90 天，可配置 |
| `weekly/*.md` | 每周 Routine 触发  | 同上                                           | 保留 1 年，可配置  |
| `memory.md`   | 首次启动时创建模板 | 系统追加、用户自由编辑                         | 永久保留           |

### 5.3 日摘要 MD 格式

```markdown
---
date: 2026-04-07
screen_time: 8h 32m
top_apps: [VS Code, Chrome, Terminal]
generated_at: 2026-04-07T23:55:00+08:00
model: gpt-4o-mini
---

# 2026-04-07 (周一)

## 概览

今天主要在开发 Recaply Sense 项目的 Storage 层，包括 SurrealDB Repository 实现和 migration runner 编写。

## 时间线

### 09:00 - 12:00 | 编码 (VS Code)

- 实现 SurrealDB Repository 层 CRUD 操作
- 编写 migration runner 和初始 schema
- 50 个单元测试全部通过

### 13:00 - 15:00 | 调研 (Chrome)

- 查阅 SurrealDB 3.x 官方文档
- 研究 Bun + WASM 兼容性

### 15:30 - 17:30 | 编码 + 文档 (VS Code + Terminal)

- 完成 Phase 1 代码审查
- 更新架构文档

## 关键实体

- **项目**: Recaply Sense
- **技术**: SurrealDB, TypeScript, Bun
- **工具**: VS Code, Chrome, Terminal

## 数据

- 屏幕时间: 8h 32m
- 截图数: 2,430
- 活动段数: 12
- 实体数: 8
```

---

## 6. 数据模型

### 6.1 rem_summary 表

```surql
DEFINE TABLE rem_summary SCHEMAFULL;

DEFINE FIELD type           ON rem_summary TYPE string
  ASSERT $value IN ['daily', 'weekly', 'monthly'];
DEFINE FIELD period_start   ON rem_summary TYPE datetime;
DEFINE FIELD period_end     ON rem_summary TYPE datetime;
DEFINE FIELD timezone       ON rem_summary TYPE string;
DEFINE FIELD local_date     ON rem_summary TYPE string;       -- 'YYYY-MM-DD' 或 'YYYY-WNN'
DEFINE FIELD content        ON rem_summary TYPE string;       -- Markdown 正文
DEFINE FIELD key_topics     ON rem_summary TYPE array<string>;
DEFINE FIELD stats          ON rem_summary TYPE object;       -- { screen_time, app_distribution, ... }
DEFINE FIELD embedding      ON rem_summary TYPE option<array<float>>;
DEFINE FIELD embedding_model ON rem_summary TYPE string DEFAULT 'bge-m3-v1';
DEFINE FIELD llm_model      ON rem_summary TYPE string;
DEFINE FIELD schema_version ON rem_summary TYPE int DEFAULT 1;
DEFINE FIELD routine_id     ON rem_summary TYPE option<string>; -- 关联的 Routine ID
DEFINE FIELD created_at     ON rem_summary TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at     ON rem_summary TYPE datetime DEFAULT time::now();
```

### 6.2 routine 表（自定义 Routines，后续迭代）

```surql
DEFINE TABLE routine SCHEMAFULL;

DEFINE FIELD name           ON routine TYPE string;
DEFINE FIELD prompt         ON routine TYPE string;
DEFINE FIELD schedule       ON routine TYPE string;                 -- cron 表达式
DEFINE FIELD enabled        ON routine TYPE bool DEFAULT true;
DEFINE FIELD last_run_at    ON routine TYPE option<datetime>;
DEFINE FIELD created_at     ON routine TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at     ON routine TYPE datetime DEFAULT time::now();
```

### 6.3 不入库的数据

`memory.md` **不入库**——它就是一个文件，Agent 读取时当文本处理。理由：

- 避免文件和 DB 双向同步的复杂性
- 用户可以用任何编辑器修改
- 外部 Agent 可以直接 `cat` 读取
- 简单就是好的

---

## 7. MCP 暴露方式

REM 层通过 MCP Resources 暴露给外部 Agent：

```typescript
// MCP Resources
{
  uri: "rem://daily/2026-04-07",
  name: "日摘要 2026-04-07",
  mimeType: "text/markdown",
}

{
  uri: "rem://weekly/2026-W15",
  name: "周回顾 Week 15",
  mimeType: "text/markdown",
}

{
  uri: "rem://memory",
  name: "用户记忆",
  mimeType: "text/markdown",
}
```

外部 Agent 也可以直接读取文件系统中的 MD 文件（作为备用通道）。

---

## 8. Agent 集成

### 8.1 内部 Agent 使用知识

Agent 在回答用户问题时，自动引用知识上下文：

```
System Prompt 构成:
  1. 基础系统 prompt（角色定义 + 工具说明）
  2. memory.md 内容（用户记忆）
  3. 今日摘要（如果已生成）
  4. 最近的搜索上下文
```

### 8.2 Memory 写入

Agent 在以下场景自动写入 `memory.md`：

1. 用户显式请求："记住我偏好用 Bun"
2. 对话结束后推断：从对话中提取显著偏好/事实（标记 `[inferred]`）

写入时使用**追加模式**（append），不修改已有内容。用户可以手动编辑/删除不准确的条目。

---

## 9. 实现阶段

| Phase         | 内容                                                                              | 依赖               |
| ------------- | --------------------------------------------------------------------------------- | ------------------ |
| **Phase 2**   | 预留 `rem_summary` 表 schema（migration 中定义）                                  | Phase 1 storage 层 |
| **Phase 4**   | Vision 模块生成 activity_segment 时，同步标记为 REM 层原材料                      | Phase 4 Vision     |
| **Phase 4.5** | 完整 REM 层实现：Generators + Memory + MD Export + Scheduler 任务 + MCP Resources | Phase 4            |
| **Phase 6**   | Desktop UI 展示 Routines 推送结果                                                 | Phase 6 UI         |
| **后续迭代**  | 自定义 Routines、Memory 自动推断优化、月度回顾                                    | -                  |

---

## 10. 设计约束与未来扩展

### 10.1 当前约束

- Memory 不入库，不支持语义搜索 memory 条目（后续可加）
- 日/周摘要依赖 activity_segment 质量，Vision 模块是前置依赖
- 自定义 Routines 推迟到基础 Routines 验证后再做

### 10.2 未来可能的扩展

| 扩展                | 说明                                                      | 优先级 |
| ------------------- | --------------------------------------------------------- | ------ |
| **实体知识卡**      | 自动聚合实体的使用频率、关联上下文生成 `entities/*.md`    | 中     |
| **月度回顾**        | 更长周期的行为模式分析和洞察                              | 低     |
| **Memory 语义搜索** | memory.md 内容入库 + embedding，支持 Agent 精确检索记忆   | 中     |
| **Obsidian 同步**   | 类似 Screenpipe，将日报同步到 Obsidian vault              | 低     |
| **行为洞察推送**    | 基于长期数据检测模式变化（如 "这周编码时间比上周少 30%"） | 低     |
