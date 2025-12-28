# LangGraph 最佳实践重构计划

本计划旨在从根本上重构后端工作流，使其符合 LangGraph 最佳实践，追求**优雅**、**可读性**和**可扩展性**。

---

## ✅ Phase 1: 基础设施升级 (Backend)

### 1.1 原生 Checkpointer 集成 ✅

- [x] 创建 `src/lib/saver.ts`，初始化 `SqliteSaver` 实例
- [x] 修改 `createSummaryWorkflow()` 使用 `.compile({ checkpointer })` 编译
- [x] 为每个任务生成唯一 `thread_id`，支持断点续传

### 1.2 Checkpoint 职责分离

> 已推迟：当前 `CheckpointManager` 仍用于数据持久化，运行状态通过 LangGraph Stream 管理。

---

## ✅ Phase 2: 图结构优化 (Backend)

### 2.1 类型安全重构 ✅

- [x] 移除 `graph.ts` 中所有 `as any` 类型断言
- [x] 定义 `NodeName` 类型联合，实现类型安全的边定义
- [x] 使用类型安全辅助函数 `addEdge` 和 `addConditionalEdges`

### 2.2 Node 纯函数化 ✅

- [x] 移除所有 Node 内部的 `checkpoint.updateProgress` 调用
- [x] 进度追踪改为通过 State 的 `progress` 和 `currentStep` 字段

### 2.3 Send API 并发模型 ✅

- [x] 重构 `daily_summarizer` 使用 Fan-out/Fan-in 模式
- [x] `fanOutDailyNode` 准备数据，`routeFanOutDaily` 返回 `Send[]`
- [x] `processSingleDailyNode` 独立处理每一天，结果通过 reducer 聚合

---

## ✅ Phase 3: 进度流式推送 (Backend)

### 3.1 Streaming API 重构 ✅

- [x] 修改 `POST /generate` 使用 `workflow.stream()` 替代 `workflow.invoke()`
- [x] 使用 `streamMode: "updates"` 获取每个节点的状态变更
- [x] 重构 SSE 事件格式: `{ nodeId, state: { progress, currentStep, ... }, timestamp }`

### 3.2 统一初始化 ✅

- [x] 创建 `setup` Node 作为图的第一个节点
- [x] 统一初始化 `CheckpointManager`

---

## ✅ Phase 4: 前端同步更新 (Frontend)

### 4.1 SummaryContext 重构 ✅

- [x] 更新 `SummaryContext.tsx` 以适配新的 SSE 事件格式
- [x] 从 `state.progress` 和 `state.currentStep` 读取进度
- [x] 添加 `SSEEvent` 类型定义

### 4.2 向后兼容 ✅

- [x] 保留对旧事件格式的 fallback 处理
- [x] 新旧格式平滑过渡

---

## ✅ Phase 5: 代码清理 (全栈)

### 5.1 后端清理 ✅

- [x] 移除未使用的 `processDailySummariesBatch` 导出
- [x] 移除未使用的 `processAllMonthlySummaries` 导入
- [x] 清理 `server.ts` 中的废弃代码和注释

### 5.2 前端清理 ✅

- [x] 前端代码已适配新格式，无需额外清理

### 5.3 文档更新 ✅

- [x] 更新本文档，标记所有完成项目

---

## 最终架构

```
┌─────────────────────────────────────────────────────────────┐
│                      工作流执行                               │
├─────────────────────────────────────────────────────────────┤
│  START                                                       │
│    ↓                                                        │
│  setup (初始化 CheckpointManager)                            │
│    ↓                                                        │
│  collect_data (收集 Git 提交数据)                            │
│    ↓                                                        │
│  fan_out_daily (准备数据，返回 Send[])                       │
│    ↓                                                        │
│  ┌──────────────────────────────────────────┐               │
│  │  process_single_daily (并行处理每一天)    │               │
│  │  process_single_daily                    │               │
│  │  ...                                     │               │
│  └──────────────────────────────────────────┘               │
│    ↓                                                        │
│  weekly_summarizer / monthly_summarizer / persist           │
│    ↓                                                        │
│  END                                                        │
└─────────────────────────────────────────────────────────────┘
```

## 关键改进

1. **Send API**: 真正的并行处理，每个日期独立执行
2. **workflow.stream()**: 实时获取节点执行状态
3. **setup 节点**: 统一初始化，避免重复
4. **纯函数节点**: 无副作用，只修改 State
5. **类型安全**: 完整的 TypeScript 类型覆盖
