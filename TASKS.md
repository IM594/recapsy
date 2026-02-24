# Recaply Sense 任务分解（TASKS）

> 版本：v0.1（文档阶段）
> 状态：待确认
> 关联规格：`/Users/user/Downloads/projects/my/recaply-sense/SPEC_v2.md`

## 1. 总体执行策略

1. 先文档后代码，按 `M0 -> M1 -> M1.1` 顺序推进。
2. 所有任务默认以 Offline 路径落地，再追加 Cloud 插件能力。
3. 每项功能至少 1 个测试；关键链路必须有可回归测试。
4. 不复制旧仓实现代码，仅可依据白名单提炼原则并重写。

## 2. 任务编排与依赖

### 2.1 M0（离线闭环 + `.app` 可运行）

| ID | 任务 | 产出 | 测试要求 | SPEC 对应 |
| --- | --- | --- | --- | --- |
| T-M0-01 | 初始化 Xcode 工程与模块骨架（`AppShell/CaptureCore/ProcessingCore/MemoryStore/RetrievalCore/McpGateway`） | 可编译工程、模块目录与协议定义 | `build` 通过 + 模块初始化单测 | 6,14,17 |
| T-M0-02 | 单实例锁与启动守护机制 | 防重复启动、异常退出清理策略 | 单测覆盖重复启动与锁释放 | 15,17 |
| T-M0-03 | 权限探测流程（Screen Recording、Accessibility、Microphone 占位） | 权限状态机与 UI 提示 | 集成测试验证权限缺失提示可操作 | 6,15,17 |
| T-M0-04 | 屏幕采集链路（2s 间隔 + 去重） | `frames` 原始记录入库 | 单测覆盖 hash 去重逻辑 | 3,4,5,20 |
| T-M0-05 | OCR 与文本压实（2 分钟窗口） | `chunks` 写入与 `chunks_fts` 建立 | 集成测试验证 OCR->chunk->FTS 查询 | 3,4,7,9,10 |
| T-M0-06 | SQLite schema v1 + WAL + 索引 | 8 张核心表与关键索引 | 迁移测试 + 索引存在性测试 | 6,9,10 |
| T-M0-07 | 本地检索 v1（FTS TopN） | `search(query, filters)` | 回归测试验证 TopN 与过滤条件 | 5,7,15,17 |
| T-M0-08 | MCP v1 最小工具（`search/get_chunk`）+ `stdio` | MCP 本地可调用 | 协议测试（输入输出 schema） | 5,12,17 |
| T-M0-09 | `.app` 打包脚本与双击运行路径 | 可双击运行应用产物 | 手工验收 + CI 构建任务 | 1,14,17 |
| T-M0-10 | 备份/恢复骨架（导出/导入 + 索引重建触发） | 基础导入导出流程 | 集成测试验证导入前快照与回滚 | 16,17 |

### 2.2 M1（音频 + 混合检索 + Provider 框架）

| ID | 任务 | 产出 | 测试要求 | SPEC 对应 |
| --- | --- | --- | --- | --- |
| T-M1-01 | 音频采集 gating（仅麦克风激活） | 音频采集开关与事件关联 | 单测覆盖激活/未激活行为 | 3,8,17 |
| T-M1-02 | 本地 ASR 管线与 `audio_segments` 入库 | 音频转写与时间轴关联 | 集成测试验证 ASR 入库与检索可见 | 8,9,10,17 |
| T-M1-03 | 向量 Provider 抽象 (`EmbeddingProvider/VectorStoreProvider`) | Provider 接口与默认 local 实现 | 单测覆盖接口契约和 fallback | 6,7,19 |
| T-M1-04 | 混合检索（FTS + Vector + RRF） | `hybridSearch` 可用 | 回归测试验证融合排序稳定性 | 7,15,17 |
| T-M1-05 | Cloud Provider 框架（至少 1 个可选实现） | 可配置 provider + 健康检查 | 集成测试验证 Cloud 失败自动回退 | 5,11,17,19 |
| T-M1-06 | SyncCore（outbox + 幂等 + 重试退避） | 同步后台 worker | 集成测试验证 outbox 不阻塞本地写入 | 5,11,15 |
| T-M1-07 | `Streamable HTTP` MCP 通道 + token 鉴权 | `/v1/*` 只读接口可用 | 安全测试验证 token 脱敏与 127.0.0.1 绑定 | 12 |
| T-M1-08 | 危险删除语义与维护任务（1h/1d/all） | 删除与重建一致性 | 回归测试覆盖删除后检索一致性 | 10,15,17 |

### 2.3 M1.1（Ask + Chat 引用闭环）

| ID | 任务 | 产出 | 测试要求 | SPEC 对应 |
| --- | --- | --- | --- | --- |
| T-M1.1-01 | `AskService` 协议与本地实现 | `ask(question, filters)` | 单测覆盖输入输出 schema | 13,19 |
| T-M1.1-02 | Chat UI（从占位到可交互） | Chat 页签与问答流程 | UI 测试覆盖提问、加载、错误态 | 3,13,17 |
| T-M1.1-03 | 引用模型固定化（chunk/audio_segment） | `citations[]` 标准对象 | 单测覆盖字段完整性与可序列化 | 13 |
| T-M1.1-04 | `recapsense_ask` MCP 工具 | MCP v1.1 可调用 | 协议测试 + 引用字段校验 | 12,13 |
| T-M1.1-05 | 引用跳转与定位链路 | 从答案跳转到明细 | 集成测试验证可定位率 | 13,17 |
| T-M1.1-06 | 20 题标准样本回归集 | 可重复评估引用质量 | 回归报告：定位率 100% | 17 |

## 3. 横切任务（所有阶段）

| ID | 横切主题 | 说明 | 最低测试门槛 | SPEC 对应 |
| --- | --- | --- | --- | --- |
| T-X-01 | Offline 默认策略 | 所有新能力先落本地实现 | 每个能力 1 个 offline 单测 | 2,5 |
| T-X-02 | Cloud 可插拔与自动回退 | Cloud 只增强不替代 | 每个 Cloud 接口 1 个 fallback 测试 | 5,11 |
| T-X-03 | 可观测性与日志规范 | 时间戳、启动分隔线、错误分级 | 日志格式快照测试 | 15 |
| T-X-04 | 数据迁移与恢复 | 迁移脚本、导入前备份、失败回滚 | 导入失败回滚集成测试 | 16 |
| T-X-05 | 安全与隐私 | token 脱敏、麦克风授权、默认不外发 | 安全策略测试 | 8,11,12 |

## 4. 第一周可执行清单（每天可验收）

| Day | 当日目标 | 当日验收标准（可执行） |
| --- | --- | --- |
| D1 | 工程初始化与模块骨架 | `xcodebuild -scheme RecaplySense build` 成功；模块目录与协议可编译 |
| D2 | SQLite schema v1 与本地仓储层 | 数据库初始化测试通过；8 张核心表与索引存在性断言通过 |
| D3 | 屏幕采集最小链路与去重 | 模拟采集 500 帧后去重率可观测；`frames` 写入正确 |
| D4 | OCR -> chunk 压实 -> FTS | 给定样本截图可检索到对应 chunk；FTS Top10 返回稳定 |
| D5 | MCP `stdio` 最小工具 | `recapsense_search` 与 `recapsense_get_chunk` 在本机可调用 |
| D6 | 单实例锁 + 权限诊断 | 重复启动被拦截；缺失权限时 UI 提示与引导正确 |
| D7 | `.app` 打包与 8 小时稳定性预跑 | 可双击启动；长跑监控期间无崩溃、重启后数据可查 |

## 5. Definition of Done（DoD）

1. 功能完成：需求、错误态、回退路径全部实现。
2. 测试完成：至少 1 个测试，关键链路有回归测试。
3. 文档完成：更新 `ARCHITECTURE.md`、`MILESTONES.md`、`DECISIONS.md` 对应条目。
4. 可观测完成：日志可定位问题，关键指标可导出。
5. 安全完成：隐私约束、鉴权、脱敏规则已验证。

## 6. SPEC 对齐总表

| SPEC 关键主题 | 任务覆盖位置 |
| --- | --- |
| 双模式运行（Offline/Cloud/Fallback） | T-X-01, T-X-02, T-M1-05 |
| 向量策略（L1/L2/L3 + chunk 粒度） | T-M1-03, T-M1-04 |
| 音频策略（麦克风激活、ASR、隐私） | T-M1-01, T-M1-02, T-X-05 |
| 云同步策略（outbox/幂等/冲突） | T-M1-06 |
| MCP（stdio + HTTP + 安全） | T-M0-08, T-M1-07, T-M1.1-04 |
| 聊天引用（ask + citations） | T-M1.1-01 ~ T-M1.1-06 |
