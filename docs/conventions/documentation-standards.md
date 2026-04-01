# 文档标准

> 适用范围：monorepo 全局

## 1. 文档体系

```
docs/
├── architecture/         # 架构设计文档（已有）
│   ├── system-overview.md
│   ├── module-boundaries.md
│   ├── data-models.md
│   ├── api-contracts.md
│   ├── tech-decisions.md
│   ├── operational-design.md
│   └── directory-structure.md
├── conventions/          # 开发规范文档（本系列）
│   ├── git-workflow.md
│   ├── typescript-style.md
│   ├── ...
│   └── i18n-strategy.md
└── guides/               # 操作指南（未来）
    ├── getting-started.md
    ├── local-development.md
    └── troubleshooting.md

.claude/skills/           # Claude Code Skills（按需加载入口）
├── arch.md               # 系统架构 + 模块边界 + 技术决策
├── data.md               # 数据模型
├── api.md                # 接口契约
├── ts-dev.md             # TypeScript 开发规范
├── swift-dev.md          # Swift 开发规范
└── ops.md                # 运维 + CI/CD + 发版 + 目录结构
```

> **Skills 与 docs 的关系**：`.claude/skills/` 是 `docs/` 的按需加载入口，每个 skill 引用对应的源文件路径。Claude Code 通过 `/arch`、`/data` 等命令触发 skill，仅加载相关文档到上下文，避免一次性加载全部 ~8300 行。

---

## 2. 文档语言

| 类别           | 语言     | 理由                         |
| -------------- | -------- | ---------------------------- |
| 架构文档       | 中文     | 核心设计文档，中文表达更精确 |
| 开发规范       | 中文     | 与架构文档一致               |
| 代码注释       | 英文     | 代码中英文统一               |
| TSDoc/JSDoc    | 英文     | 跟随代码语言                 |
| README.md      | 中英双语 | 仓库首页，兼顾展示           |
| Commit Message | 英文     | Git 工作流规范要求           |
| Changelog      | 英文     | 自动化工具生成               |

---

## 3. TSDoc 注释约定

### 何时写 TSDoc

- ✅ 所有 **公开导出** 的函数、类型、接口
- ✅ 复杂逻辑的内部函数
- ❌ 显而易见的 getter/setter
- ❌ 测试代码

### 格式

````typescript
/**
 * Search screenshots by hybrid strategy combining vector and fulltext.
 *
 * Executes vector search and fulltext search in parallel, then merges
 * results using reciprocal rank fusion (RRF).
 *
 * @param query - Search query with optional filters
 * @param options - Search options (limit, offset, strategy override)
 * @returns Merged search results sorted by relevance score
 * @throws {SearchError} When search execution fails
 * @throws {ValidationError} When query is empty or filters are invalid
 *
 * @example
 * ```typescript
 * const results = await hybridSearch(
 *   { text: "VS Code", timeRange: { start, end } },
 *   { limit: 20 },
 * );
 * ```
 */
export async function hybridSearch(
  query: SearchQuery,
  options?: SearchOptions,
): Promise<SearchResult> { ... }
````

### 常用 TSDoc 标签

| 标签          | 用途                         |
| ------------- | ---------------------------- |
| `@param`      | 参数说明                     |
| `@returns`    | 返回值说明                   |
| `@throws`     | 可能抛出的异常               |
| `@example`    | 使用示例                     |
| `@see`        | 关联参考（其他函数/文档）    |
| `@internal`   | 标记内部 API（不暴露给外部） |
| `@deprecated` | 标记废弃（附迁移说明）       |

### 类型/接口文档

```typescript
/** Configuration for the ingestion pipeline. */
export interface IngestionConfig {
  /** Maximum retry attempts before moving to dead letter. Default: 3. */
  maxRetries: number;

  /** Backoff intervals in seconds for each retry. */
  retryBackoffSeconds: number[];

  /** Minimum diff ratio to accept a screenshot (skip below this). */
  minDiffRatio: number;

  /** Maximum OCR text length before truncation. */
  maxOcrTextLength: number;
}
```

---

## 4. 技术决策记录（TDR）

### 现有格式

项目已有 19 个 TDR 在 `tech-decisions.md` 中。新决策沿用同样格式：

```markdown
### TDR-XXX: <决策标题>

**背景**：为什么需要做这个决定

**决策**：选择了什么方案

**理由**：

- 理由 1
- 理由 2

**否决方案**：

- 方案 A（否决理由）
- 方案 B（否决理由）

**风险与缓解**：

- 风险 → 缓解措施
```

### 何时创建 TDR

- 选择新的库/框架/工具
- 改变架构模式或模块边界
- 做出不可逆或高成本的技术选择
- 推翻之前的 TDR

### 编号规则

- 递增编号：TDR-020, TDR-021, ...
- 一旦分配，编号不重用
- 已废弃的 TDR 标注 `[已废弃 → 见 TDR-XXX]`

---

## 5. README 模板

### 仓库根 README

```markdown
# Recaply Sense

> macOS 原生的个人记忆系统 / Personal memory system for macOS

[English](#english) | [中文](#中文)

## 中文

### 简介

一句话描述。

### 功能特性

- 功能 1
- 功能 2

### 快速开始

安装和使用步骤。

### 技术架构

简要概述 + 链接到 docs/architecture/

### 开发指南

链接到 docs/guides/getting-started.md

---

## English

### Overview

One-line description.

### Features

...

### Quick Start

...
```

### 子包 README（packages/engine/README.md）

````markdown
# @recaply/engine

> Recaply Sense 后端核心引擎

## 模块结构

简述子模块及职责。

## 开发

\```bash
bun install
bun run dev
bun test
\```

## API

链接到 api-contracts.md
````

---

## 6. Changelog 格式

遵循 [Keep a Changelog](https://keepachangelog.com/)：

```markdown
# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- feat(search): hybrid search combining vector and fulltext (#12)

### Fixed

- fix(ingestion): handle null ocr_text in pipeline (#15)

### Changed

- refactor(storage): extract repository interface (#18)

## [0.1.0] - 2026-04-15

### Added

- Initial release with screenshot ingestion pipeline
- Vector search and fulltext search
- REST API for frontend communication
```

### 自动化

配合 Conventional Commits，可用工具自动生成：

- `changelogen`（推荐，轻量）
- `conventional-changelog`

```bash
# 生成 changelog
bunx changelogen
```

---

## 7. 内联文档规范

### 文件头注释（不需要）

```typescript
// ❌ 不需要文件头注释（文件名已说明用途）
/**
 * @file search-service.ts
 * @description Search service implementation
 * @author ...
 * @date ...
 */

// ✅ 文件用途如果不明显，一行注释即可
// Reciprocal Rank Fusion implementation for merging multi-strategy search results
```

### TODO 规范

```typescript
// TODO: description of what needs to be done
// TODO(#42): linked to GitHub issue
// FIXME: known bug that needs fixing
// HACK: workaround, explain why and when to remove

// ❌ 不要写没有信息的 TODO
// TODO: fix this
// TODO: refactor later
```

---

## 8. 架构文档维护规则

| 规则            | 说明                                               |
| --------------- | -------------------------------------------------- |
| **同步更新**    | 代码变更涉及架构文档描述的内容时，同一 PR 更新文档 |
| **TDR 不可变**  | 已有 TDR 不修改，推翻则新建 TDR 并标注引用         |
| **API 契约**    | API 变更必须先更新 `api-contracts.md`（契约先行）  |
| **数据模型**    | 表结构变更必须更新 `data-models.md`                |
| **Skills 同步** | 源文件增删或路径变更时，同步更新 `.claude/skills/` 中的引用 |
| **Review 检查** | Code Review 检查文档和 Skills 是否需要同步更新     |
