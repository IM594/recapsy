# Recaply Sense 架构设计（ARCHITECTURE）

> 版本：v0.1（文档阶段）
> 状态：待确认
> 权威规格：`/Users/user/Downloads/projects/my/recaply-sense/SPEC_v2.md`
> 参考边界：`/Users/user/Downloads/projects/my/recaply-sense/REFERENCE_WHITELIST.md`

## 1. 目标与约束

1. 本系统是 **Offline-by-default** 的 macOS 原生个人记忆系统。
2. 核心链路在断网条件下必须可用：采集、OCR、ASR、入库、检索、MCP。
3. Cloud 仅作为增强层，通过 Provider 接口插拔接入。
4. 任一 Cloud Provider 失败时必须自动回退到 Offline 路径，不得阻塞主功能。
5. 输出必须可追溯，尤其是检索结果与未来 Chat 答案的引用链路。

## 2. 系统上下文

1. 平台：macOS 13+。
2. 语言与框架：Swift 5.9+、SwiftUI、ScreenCaptureKit、Vision、Speech Framework。
3. 数据层：SQLite（WAL）+ FTS5 + 可插拔本地向量索引。
4. 对外接口：MCP `stdio` 与 `Streamable HTTP`（默认仅本机地址）。

## 3. 双模式运行模型（强制）

### 3.1 模式定义

1. `Offline Mode`：默认模式，所有核心能力仅依赖本地实现。
2. `Cloud-Enhanced Mode`：用户显式开启并配置 Provider 后启用。

### 3.2 回退规则

1. 每个 Cloud 调用都必须有本地可替代路径。
2. Cloud 调用失败（超时、鉴权、网络、限流）后自动降级到本地路径。
3. 降级不改变 API 结构，仅在元数据中记录 `provider_used` 与 `fallback_reason`。
4. 降级事件写入审计日志，供设置页与诊断页展示。

### 3.3 模式状态机

1. `OfflineReady`：默认启动状态。
2. `CloudEnabled`：配置合法且健康检查通过。
3. `CloudDegraded`：Cloud 失败，自动回退本地执行。
4. `CloudRecovering`：后台重试健康检查，成功后恢复增强模式。

## 4. 模块划分与边界

1. `AppShell`
- 职责：菜单栏、主窗口、设置、健康状态与权限引导。
- 输入：各核心模块状态。
- 输出：用户操作命令（start/stop/pause/resume）。

2. `CaptureCore`
- 职责：屏幕采集、音频采集、去重、采集节流。
- 输入：权限状态、采样配置。
- 输出：`frames`、原始音频片段、采集事件。

3. `ProcessingCore`
- 职责：OCR、ASR、文本清洗、chunk 压实。
- 输入：采集原始数据。
- 输出：`chunks`、`audio_segments`、派生索引任务。

4. `MemoryStore`
- 职责：SQLite schema、事务写入、FTS、索引维护。
- 输入：结构化记录。
- 输出：查询结果、维护结果、导入导出数据。

5. `RetrievalCore`
- 职责：FTS 召回、向量检索、融合排序、引用构建。
- 输入：query + filters。
- 输出：TopN 结果与标准化 `citations`。

6. `ProviderSDK`
- 职责：封装 Embedding/Vector/ObjectStorage/LLM Provider。
- 输入：标准接口调用。
- 输出：统一结果模型 + 错误语义。

7. `SyncCore`
- 职责：outbox、幂等上传、冲突处理、重试退避。
- 输入：本地事件流。
- 输出：同步结果、游标更新、冲突日志。

8. `McpGateway`
- 职责：MCP 协议适配、鉴权、限流与审计。
- 输入：MCP 请求。
- 输出：只读工具结果（v1/v1.1）。

## 5. 关键数据流

### 5.1 屏幕链路

1. `CaptureCore` 按 2 秒采样获取 frame。
2. 去重后进入 `ProcessingCore` OCR。
3. OCR 文本按 2 分钟窗口压实为 `chunks`。
4. `MemoryStore` 事务写入 `frames/chunks` 并更新 FTS。
5. 异步触发向量构建任务（粒度为 `chunk`，禁止 frame 粒度长期向量）。

### 5.2 音频链路

1. 仅当麦克风激活事件成立时启动采集。
2. 原始音频切片进入 ASR（本地优先）。
3. ASR 文本写入 `audio_segments` 并关联时间轴。
4. 若用户开启云 ASR，失败时自动回退本地 ASR 或延迟重试。

### 5.3 查询链路

1. `RetrievalCore` 先执行 FTS TopN 召回。
2. 执行向量检索或重排。
3. 使用 RRF/加权融合输出最终排序。
4. 构造引用对象：`{type,id,start_ts,end_ts,app,window}`。

### 5.4 同步链路

1. 本地写入成功后写 `sync_outbox`。
2. `SyncCore` 后台批量发送，携带 `idempotency_key`。
3. 失败按指数退避，成功更新 `sync_cursor`。
4. 冲突按“最后写入 + 可回溯日志”处理。

## 6. 向量策略

### 6.1 L1 本地轻量层（默认）

1. 以 SQLite 主库存储实体与元数据。
2. 本地向量索引插件化接入。
3. 最小索引对象是 `chunks`，可选扩展到 `audio_segments`。

### 6.2 L2 云增强层（可选）

1. 本地保持最小可用索引。
2. 云端维护完整向量与过滤检索能力。
3. 同步方式是异步 upsert + 幂等重放。

### 6.3 L3 冷热分层（后续）

1. 热数据留本地高性能检索。
2. 冷数据向量与媒体归档云端，按需回拉。

## 7. 音频策略与隐私策略

1. 音频默认不常驻录音，仅麦克风激活时采集。
2. 未授权麦克风时严禁触发采集链路。
3. 默认音频内容不外发。
4. 开启云 ASR 前执行二次确认。
5. 原始音频按可配置热窗口保留（建议 90 天）。

## 8. 云同步与安全策略

1. 云开关默认关闭，必须在设置页显式开启。
2. Token/Key 存储在 Keychain。
3. 支持一键断连并清空凭据。
4. 云同步不可阻塞本地写入与本地查询。
5. 网络中断或 provider 故障时保持 Offline 可用。

## 9. MCP 与聊天引用设计

### 9.1 MCP v1

1. `recapsense_search`
2. `recapsense_get_chunk`
3. `recapsense_get_daily_summary`
4. `recapsense_get_timeline`（可选）

### 9.2 MCP v1.1

1. `recapsense_ask`
2. 返回结构必须包含 `answer` 与 `citations[]`。

### 9.3 安全与协议边界

1. `Streamable HTTP` 默认监听 `127.0.0.1`。
2. `/v1/*` 必须 token 鉴权。
3. 日志禁止输出明文 token。

## 10. 数据模型与存储分层

### 10.1 核心表

1. `frames`
2. `chunks`
3. `audio_segments`
4. `embeddings`
5. `summaries_daily`
6. `settings`
7. `sync_outbox`
8. `sync_cursor`

### 10.2 索引与约束

1. `chunks_fts` 作为主文本检索入口。
2. `embeddings(entity_type, entity_id)` 唯一。
3. 时间与 app 维度必须有 B-tree 索引。

### 10.3 保留层次

1. 长期层：`chunks`、`audio_segments.text`、`summaries_daily`、`settings`。
2. 热证据层：截图与原始音频（可配置期限）。
3. 派生层：FTS、向量索引、统计缓存（可重建）。

## 11. 打包、发布与可运维性

1. 首版 `.app` 目标体积 40-80MB。
2. 不内置大模型权重。
3. 用户无需安装 Node/Python。
4. 首次启动必须完成权限引导与健康检查。
5. 稳定性要求：异常退出无残留子进程，日志带时间戳与启动分隔线。

## 12. SPEC 映射矩阵

| SPEC 章节 | 架构落位 | 关键说明 |
| --- | --- | --- |
| 1 背景与目标 | 1,2,11 | 本地优先 + 可打包 + MCP + 可追溯 |
| 2 产品原则 | 1,3,6,8,9 | Offline 默认、Provider 抽象、Traceable AI |
| 3 业务范围 | 4,5,9 | M0/M1/M1.1 对应链路分层 |
| 4 规模与约束 | 5,6,10 | 向量粒度限制为 chunk，媒体分层 |
| 5 双模式 | 3 | Offline 默认 + Cloud 增强 + 自动回退 |
| 6 技术栈/模块 | 2,4 | 模块职责与技术边界固定 |
| 7 向量策略 | 6 | L1/L2/L3 分层与混合检索 |
| 8 音频策略 | 5.2,7 | 麦克风激活采集 + 隐私约束 |
| 9 数据模型 | 10 | 表结构与索引职责 |
| 10 存储层次 | 10.3 | 长期/热证据/派生三层 |
| 11 云能力 | 8 | 插拔式能力与同步边界 |
| 12 MCP 设计 | 9 | v1/v1.1 工具与安全策略 |
| 13 聊天能力 | 9.2 | ask 输出必须含 citations |
| 14 打包发布 | 11 | 双击运行 `.app` 与发布约束 |
| 15 SLO | 11 | 性能稳定性与日志规范 |
| 16 迁移备份恢复 | 4,10,11 | 导出导入与派生索引重建 |
| 17 里程碑验收 | 见 `MILESTONES.md` | 里程碑与可执行验收分离维护 |
| 18 风险缓解 | 3,6,7,8 | 通过抽象层与策略开关缓解 |
| 19 决策清单 | 见 `DECISIONS.md` | 开工前拍板项单独管控 |
| 20 推荐默认配置 | 5,7,10 | 作为初始化默认值 |
