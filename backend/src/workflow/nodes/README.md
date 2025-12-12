# Workflow Nodes 文档

本目录包含工作流的所有节点（Nodes），每个节点负责特定的功能。

## 📊 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    数据收集层 (并行执行)                      │
├─────────────────┬─────────────────┬─────────────────────────┤
│ collectGitCommits│ collectGitDiffs │ collectUserInput       │
│                 │ (deepAnalysis)  │                         │
│                 │                 ├─────────────────────────┤
│                 │                 │ collectExternalData     │
└─────────────────┴─────────────────┴─────────────────────────┘
                            ↓
                    ┌───────────────┐
                    │  dataBarrier  │ ← 同步等待所有收集器
                    └───────────────┘
                            ↓
              ┌─────────────────────────────┐
              │      diffPreprocessor       │ ← 可选：压缩大文件 diff
              │      (deepAnalysis only)    │
              └─────────────────────────────┘
                            ↓
        ┌───────────────────┴───────────────────┐
        │                                       │
   [标准模式]                              [深度分析模式]
        │                                       │
  ┌─────────────┐              ┌────────────────┴────────────────┐
  │ aiProcessor │              │                                 │
  └─────────────┘      ┌───────────────┐           ┌─────────────────────┐
                       │ contextAnalyst│           │ technicalAnalyst    │
                       │  (项目经理)    │           │  (技术负责人)        │
                       └───────────────┘           └─────────────────────┘
                                    ↘           ↙
                              ┌───────────────┐
                              │  synthesizer  │ ← 首席编辑
                              └───────────────┘
                                      ↓
                            ┌────────────────┐
                            │ exportMarkdown │ ← 输出文件
                            └────────────────┘
```

---

## 📦 数据收集层（Collectors）

### 1. `collectGitCommits` - Git 提交收集器

**文件**: `collect-git-commits.ts`

**功能**: 从选中的 Git 仓库获取 commit 记录

**逻辑流程**:

1. 从 `ConfigManager` 获取配置（作者过滤、日期范围）
2. 遍历 `state.selectedRepos` 中的每个仓库
3. 调用 `getRepoCommits()` 获取 commit 记录（带作者和日期过滤）
4. 将每个仓库的结果合并，添加仓库名作为标题
5. 统计总 commit 数并返回

**输入**:

- `selectedRepos`: 选中的仓库路径列表
- `since`: 开始日期
- `until`: 结束日期

**输出**:

- `gitCommits`: 格式化的 commit 记录字符串
- `collectorProgress: ["git_collector"]`

---

### 2. `collectGitDiffs` - Git Diff 收集器

**文件**: `collect-git-diffs.ts`

**功能**: 获取代码变更的详细 diff（仅在深度分析模式下执行）

**逻辑流程**:

1. **前置检查**: 若 `deepAnalysis` 未开启，直接返回空
2. 遍历每个选中的仓库，调用 `getRepoDiffs()` 获取代码变更详情
3. 将所有仓库的 diff 合并成一个数组

**输入**:

- `selectedRepos`: 选中的仓库路径列表
- `since`: 开始日期
- `until`: 结束日期
- `deepAnalysis`: 是否开启深度分析

**输出**:

- `gitDiffs`: `GitDiff[]` 数组
- `collectorProgress: ["diff_collector"]`

---

### 3. `collectUserInput` - 用户输入接收器

**文件**: `collect-user-input.ts`

**功能**: 接收并透传前端传入的用户补充说明

**逻辑流程**:

1. 直接透传 `state.userInput`（来自前端的补充说明）
2. 记录进度

**输入**:

- `userInput`: 前端传入的用户补充文本

**输出**:

- `userInput`: 原样透传
- `collectorProgress: ["user_input"]`

---

### 4. `collectExternalData` - 外部 API 调用器

**文件**: `collect-external-data.ts`

**功能**: 调用外部服务（如 Todoist）获取任务数据

**逻辑流程**:

1. 检查是否配置了 `TODOIST_API_KEY`，若无则跳过
2. 向 Todoist API 发送请求获取任务列表
3. 提取前 10 个任务返回
4. 错误处理：标记为非关键错误（`isCritical: false`），不阻断流程

**输入**:

- 环境变量 `TODOIST_API_KEY`

**输出**:

- `externalData`: 外部数据字符串
- `collectorProgress: ["external_api"]`

---

## 🔄 同步层

### 5. `dataBarrier` - 数据屏障

**文件**: `data-barrier.ts`

**功能**: 同步点，确保所有并行收集器完成后才继续

**逻辑流程**:

1. 定义预期的 collectors: `["git_collector", "user_input", "external_api"]`
2. 若 `deepAnalysis` 开启，额外等待 `"diff_collector"`
3. 检查 `state.collectorProgress` 是否包含所有预期项
4. 若全部就绪则继续，否则等待

**输入**:

- `collectorProgress`: 已完成的收集器列表
- `deepAnalysis`: 是否开启深度分析

**输出**: 无（仅起同步作用）

---

## 🔧 预处理层

### 6. `diffPreprocessor` - Diff 预处理器

**文件**: `diff-preprocessor.ts`

**功能**: 对过大的 diff 进行智能压缩/摘要

**逻辑流程**:

1. **前置检查**: 若 `deepAnalysis` 未开启或无 diff，直接透传
2. 计算所有 diff 的总 token 数
3. 若总 token < 30000，直接透传原始 diff
4. 若超限，对每个 token > 2000 的大文件调用 AI 进行摘要
5. 返回处理后的 diff（大文件用摘要替代）

**阈值配置**:

- `MAX_TOTAL_TOKENS`: 30000
- `FILE_TOKEN_THRESHOLD`: 2000

**输入**:

- `gitDiffs`: 原始 diff 数组

**输出**:

- `gitDiffs`: 压缩后的 diff 数组

---

## 🤖 AI 处理层

### 7. `aiProcessor` - 核心 AI 处理器（标准模式）

**文件**: `ai-processor.ts`

**功能**: 调用 LLM 分析数据生成工作总结

**逻辑流程**:

1. 从 `state.aiConfigs` 获取 AI 配置（模型、温度、API Key 等）
2. 根据 `summaryType` 生成不同的 prompt 指令：
   - `today`: 生成今日工作总结
   - `week`: 生成本周工作总结（含 ISO 周数计算）
   - `month`: 生成本月工作总结
   - `custom`: 自定义日期范围总结
3. 组装完整 prompt，包含：
   - 当前日期、目标时间范围
   - Git 提交记录、用户补充说明、外部数据
   - 格式要求（Markdown、按日期分组、非技术语言）
4. 调用 OpenAI 兼容 API
5. 返回生成的 Markdown 内容

**输入**:

- `gitCommits`: Git 提交记录
- `userInput`: 用户补充说明
- `externalData`: 外部数据
- `summaryType`: 总结类型
- `since`/`until`: 日期范围

**输出**:

- `processedContent: { markdownContent }`

---

## 🤖 Agent 层（深度分析模式）

位于 `agents/` 子目录下，用于深度分析模式的多 Agent 协作。

### 8. `contextAnalyst` - 上下文分析师

**文件**: `agents/context-analyst.ts`

**角色**: 项目经理视角

**功能**: 分析业务上下文和高层级任务

**逻辑流程**:

1. **前置检查**: 若 `deepAnalysis` 未开启，跳过
2. 分析输入：用户笔记、commit 消息、外部数据
3. 提取高层级信息：
   - 今天的主要工作焦点
   - 完成了哪些任务/ticket
   - 是否有阻塞或非技术问题
4. 输出业务层面的上下文摘要

**输入**:

- `userInput`: 用户笔记
- `gitCommits`: commit 消息
- `externalData`: 外部数据

**输出**:

- `contextualAnalysis`: 上下文分析结果

---

### 9. `technicalAnalyst` - 技术分析师

**文件**: `agents/technical-analyst.ts`

**角色**: 高级技术负责人视角

**功能**: 深度分析代码变更

**逻辑流程**:

1. **前置检查**: 若 `deepAnalysis` 未开启或无 diff，跳过
2. 深度分析代码变更：
   - 关键逻辑变更
   - 新功能
   - Bug 修复
   - 重构
   - Breaking Changes
3. 聚焦项目自定义逻辑，忽略通用框架描述

**输入**:

- `gitDiffs`: 代码 diff 数据

**输出**:

- `technicalAnalysis`: 技术分析结果

---

### 10. `synthesizer` - 综合器（首席编辑）

**文件**: `agents/synthesizer.ts`

**角色**: 首席编辑

**功能**: 融合技术分析和上下文分析生成最终报告

**逻辑流程**:

1. **同步检查**: 等待 `technicalAnalysis` 和 `contextualAnalysis` 都就绪
2. 将技术分析（"How"）和上下文分析（"What"）融合
3. 输出结构化报告：
   - 🎯 核心产出
   - 🛠️ 技术细节（引用具体文件/逻辑）
   - 🐛 问题修复
4. 面向技术负责人/工程经理

**输入**:

- `technicalAnalysis`: 技术分析结果
- `contextualAnalysis`: 上下文分析结果

**输出**:

- `processedContent: { markdownContent }`

---

## 📤 输出层

### 11. `exportMarkdown` - Markdown 导出器

**文件**: `export-markdown.ts`

**功能**: 将生成的内容保存为 Markdown 文件

**逻辑流程**:

1. 从 `state.processedContent.markdownContent` 获取内容
2. 生成文件名（`summary_YYYY-MM-DD.md`）
3. 确保 `outputs/` 目录存在
4. 添加生成时间注脚
5. 写入文件到 `outputs/` 目录

**输入**:

- `processedContent.markdownContent`: AI 生成的 Markdown 内容

**输出**:

- `outputPath`: 生成的文件路径

---

## 📊 两种工作模式对比

| 模式             | 执行路径                                                                                                                    | 适用场景                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **标准模式**     | collectors → dataBarrier → `aiProcessor` → exportMarkdown                                                                   | 快速生成，基于 commit message |
| **深度分析模式** | collectors → dataBarrier → diffPreprocessor → `contextAnalyst` + `technicalAnalyst` (并行) → `synthesizer` → exportMarkdown | 详细分析，基于代码 diff       |

---

## 🔧 添加新 Node

1. 在本目录创建新文件，如 `my-node.ts`
2. 导出一个 `async function myNode(state: WorkflowState)` 函数
3. 在 `index.ts` 中导出新 node
4. 在 `../graph.ts` 中注册并连接到工作流
