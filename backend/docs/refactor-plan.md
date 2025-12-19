# LangGraph 最佳实践重构计划

本计划旨在从根本上重构后端工作流，使其符合 LangGraph 最佳实践，追求**优雅**、**可读性**和**可扩展性**。前后端同步更新，不保留兼容层。

---

## Phase 1: 基础设施升级 (Backend)

### 1.1 原生 Checkpointer 集成

- [ ] 创建 `src/lib/saver.ts`，初始化 `SqliteSaver` 实例
- [ ] 修改 `createSummaryWorkflow()` 使用 `.compile({ checkpointer })` 编译
- [ ] 为每个任务生成唯一 `thread_id`，支持断点续传

### 1.2 Checkpoint 职责分离

- [ ] 重构 `CheckpointManager` 为纯粹的"结果导出器"
  - 仅保留 `saveDailySummary`, `loadAllDailySummaries` 等数据读写
  - 移除运行状态追踪 (`isRunning`, `progress`, `phase`)
- [ ] 运行状态改由 LangGraph State + 原生 Checkpointer 管理

---

## Phase 2: 图结构优化 (Backend)

### 2.1 类型安全重构

- [ ] 移除 `graph.ts` 中所有 `as any` 类型断言
- [ ] 为每个 Node 定义明确的输入/输出类型
- [ ] 使用 `Annotation` 的严格模式验证 State 更新

### 2.2 Node 纯函数化

- [ ] 将 `dailySummarizerNode` 拆分:
  - `load_cached_dailies`: 从磁盘加载已缓存结果
  - `process_daily` (动态): 使用 Send API 并发处理每一天
  - `merge_dailies`: 聚合结果
- [ ] 移除 Node 内部的 `checkpoint.updateProgress` 调用

### 2.3 Send API 并发模型

- [ ] 重构 `daily_summarizer` 使用 Fan-out/Fan-in 模式
- [ ] 每个 `process_day_N` 独立执行，失败可单独重试

---

## Phase 3: 进度流式推送 (Backend)

### 3.1 Streaming API 重构

- [ ] 修改 `POST /generate` 使用 `workflow.stream()` 替代 `workflow.invoke()`
- [ ] 重构 `GET /events` SSE 端点:
  - 直接基于 LangGraph stream 的 `updates` 模式输出
  - 新事件格式: `{ nodeId, state, timestamp }`
- [ ] 移除自定义 `EventEmitter` 逻辑

### 3.2 统一初始化

- [ ] 创建 `setup` Node 作为图的第一个节点
- [ ] 后续 Node 不再调用 `checkpoint.initialize()`

---

## Phase 4: 前端同步更新 (Frontend)

### 4.1 SummaryContext 重构

- [ ] 更新 `SummaryContext.tsx` 以适配新的 SSE 事件格式
- [ ] 新事件监听:
  - `node_start`: Node 开始执行
  - `node_end`: Node 执行完成，包含更新后的 State
  - `error`: 错误信息
  - `end`: 工作流结束
- [ ] 从 `state.progress` 和 `state.currentStep` 读取进度

### 4.2 状态管理优化

- [ ] 移除对旧事件 (`status`, `progress`, `complete`, `workflow_error`) 的监听
- [ ] 统一从 LangGraph State 更新中提取 UI 所需数据

### 4.3 类型定义同步

- [ ] 创建共享类型定义 (或在前端定义与后端一致的类型)
- [ ] 确保 `SummaryStatus` 接口与后端 State 对齐

---

## Phase 5: 代码清理 (全栈)

### 5.1 后端清理

- [ ] 删除 `git.ts` 中未使用的 `getRepoCommits`, `getRepoDiffs`
- [ ] 清理 `server.ts` 中注释掉的路由引用
- [ ] 移除 `CheckpointManager` 中废弃的状态管理方法

### 5.2 前端清理

- [ ] 移除不再使用的事件处理代码
- [ ] 清理过时的类型定义

### 5.3 文档与测试

- [ ] 更新 `README.md` 说明新架构
- [ ] 添加 Mermaid 图展示完整工作流
- [ ] 编写关键路径的集成测试

---

## 预期成果

| 维度     | 现状                        | 目标                            |
| -------- | --------------------------- | ------------------------------- |
| 断点续传 | 自定义实现，Node 级别       | 原生 Checkpointer，自动恢复     |
| 并发模型 | Promise.allSettled 手动控制 | Send API，每日任务独立执行      |
| 进度推送 | EventEmitter 副作用         | LangGraph Stream 原生支持       |
| 类型安全 | 大量 `as any`               | 零类型断言                      |
| 前后端   | 自定义事件协议              | 基于 LangGraph State 的统一格式 |

---

## 新 SSE 事件格式 (参考)

```typescript
// 旧格式 (将被移除)
{ event: "progress", data: { step, progress, message } }
{ event: "complete", data: { ... } }
{ event: "workflow_error", data: { message } }

// 新格式 (基于 LangGraph stream)
{ event: "node_start", data: { node: "daily_summarizer", timestamp } }
{ event: "node_end", data: { node: "daily_summarizer", state: { progress, currentStep, ... } } }
{ event: "error", data: { node: "...", error: "..." } }
{ event: "end", data: { finalState: { ... } } }
```

---

## 风险与注意事项

> [!CAUTION]
> 这是一次**全栈重构**，前后端需同步更新。建议:
>
> 1. 在 `refactor/langgraph-best-practices` 分支上进行
> 2. 每个 Phase 完成后进行端到端测试
> 3. Phase 3 和 Phase 4 必须同时完成，否则前端将无法正常工作
