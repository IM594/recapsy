# LangGraph 最佳实践重构计划

本计划旨在从根本上重构后端工作流，使其符合 LangGraph 最佳实践，追求**优雅**、**可读性**和**可扩展性**。

---

## Phase 1: 基础设施升级

### 1.1 原生 Checkpointer 集成

- [ ] 引入 `@langchain/langgraph-checkpoint-sqlite` (已安装但未使用)
- [ ] 创建 `src/lib/saver.ts`，初始化 `SqliteSaver` 实例
- [ ] 修改 `createSummaryWorkflow()` 使用 `.compile({ checkpointer })` 编译
- [ ] 为每个任务生成唯一 `thread_id`，支持断点续传

### 1.2 Checkpoint 职责分离

- [ ] 重构 `CheckpointManager` 为纯粹的"结果导出器"
  - 仅保留 `saveDailySummary`, `loadAllDailySummaries` 等数据读写
  - 移除运行状态追踪 (`isRunning`, `progress`, `phase`)
- [ ] 状态 (`isRunning`, `progress`) 改由 LangGraph State 管理

---

## Phase 2: 图结构优化

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
  ```
  collect_data -> [Send: process_day_1, process_day_2, ...] -> merge_dailies
  ```
- [ ] 每个 `process_day_N` 独立执行，失败可单独重试

---

## Phase 3: 进度流式推送

### 3.1 Streaming 替代 EventEmitter

- [ ] 修改 `POST /generate` 使用 `workflow.stream()` 替代 `workflow.invoke()`
- [ ] `GET /events` 直接读取 stream 的 `updates` 模式
- [ ] 前端通过监听 State 变化获取进度，无需自定义 EventEmitter

### 3.2 统一初始化

- [ ] 创建 `setup` Node 作为图的第一个节点
  - 初始化 CheckpointManager
  - 验证输入参数
  - 设置初始进度
- [ ] 后续 Node 不再调用 `checkpoint.initialize()`

---

## Phase 4: 代码清理

### 4.1 移除冗余代码

- [ ] 删除 `git.ts` 中未使用的 `getRepoCommits`, `getRepoDiffs`
- [ ] 清理 `server.ts` 中注释掉的路由引用
- [ ] 移除 `CheckpointManager` 中废弃的状态管理方法

### 4.2 文档与测试

- [ ] 更新 `README.md` 说明新架构
- [ ] 添加 Mermaid 图展示完整工作流
- [ ] 编写关键路径的集成测试

---

## 预期成果

| 维度     | 现状                        | 目标                        |
| -------- | --------------------------- | --------------------------- |
| 断点续传 | 自定义实现，Node 级别       | 原生 Checkpointer，自动恢复 |
| 并发模型 | Promise.allSettled 手动控制 | Send API，每日任务独立执行  |
| 进度推送 | EventEmitter 副作用         | Stream 原生支持             |
| 类型安全 | 大量 `as any`               | 零类型断言                  |

---

## 风险与注意事项

> [!CAUTION]
> 这是一次**大规模重构**，建议分阶段进行，每个 Phase 完成后进行功能验证。
>
> 建议在开始前创建 `refactor/langgraph-v2` 分支。
