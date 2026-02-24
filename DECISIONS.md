# Recaply Sense 关键决策记录（DECISIONS）

> 版本：v0.1（文档阶段）
> 状态：待确认
> 关联规格：`/Users/user/Downloads/projects/my/recaply-sense/SPEC_v2.md`

## 1. 不可变约束（已锁定）

1. 系统默认运行在 `Offline Mode`。
2. Cloud 能力必须通过 Provider 抽象插拔接入。
3. Cloud 调用失败必须自动回退到本地实现。
4. 回退后功能结果结构保持一致，不要求用户重试。
5. 聊天与 ask 输出必须包含可追溯引用。

## 2. 开工前必须拍板项（来自 SPEC 第 19 章）

| 决策 ID | 主题 | 候选方案 | 建议方案 | 状态 | 计划拍板时间 |
| --- | --- | --- | --- | --- | --- |
| D-001 | 本地向量引擎默认实现 | A: SQLite + sqlite-vec；B: SQLite + 外部本地向量库 | A（包体更小、依赖更少） | Proposed | M0 Week1 Day2 |
| D-002 | 首个云向量 provider | A: Qdrant；B: 其他托管向量服务 | A（生态成熟、过滤检索能力好） | Proposed | M1 Week1 Day1 |
| D-003 | 首个云对象存储 provider | A: S3 兼容；B: 其他对象存储 | A（接口标准化程度高） | Proposed | M1 Week1 Day1 |
| D-004 | 首个云 LLM provider | A: 先留空；B: 先接 1 家 | A（先锁接口，M1.1 再接入） | Proposed | M1.1 Week1 Day1 |
| D-005 | 音频默认保留期 | A: 30 天；B: 90 天；C: 365 天 | B（平衡隐私、可用性、存储） | Proposed | M0 Week1 Day3 |

## 3. 决策评估标准

1. 是否满足 Offline 默认与断网可用。
2. 是否支持 Cloud 插拔与自动回退。
3. 是否控制包体与运行复杂度。
4. 是否有可执行验证方案。
5. 是否满足隐私与安全约束。

## 4. ADR 记录模板

| 字段 | 说明 |
| --- | --- |
| ADR ID | 如 `ADR-YYYYMMDD-01` |
| 标题 | 英文标识符 + 中文说明 |
| 状态 | Proposed/Accepted/Superseded |
| 背景 | 问题与约束 |
| 决策 | 最终选择与范围 |
| 后果 | 正向收益与负面影响 |
| 验证 | 测试、指标、回归方式 |
| SPEC 引用 | 对应条目 |

## 5. 当前 ADR 草案

### ADR-20260224-01：Provider Abstraction First

1. 状态：Accepted。
2. 背景：需要同时满足离线可用与云增强。
3. 决策：所有模型、向量、存储、LLM 都先定义 Provider 接口，再落默认 local 实现。
4. 后果：前期抽象成本上升，但后续替换 provider 成本显著下降。
5. 验证：通过契约测试验证 local/cloud provider 行为一致性与 fallback 触发。
6. SPEC 引用：2、5、6、11、19。

### ADR-20260224-02：Chunk-level Vectorization Only

1. 状态：Accepted。
2. 背景：10 年规模下 frame 级向量会导致不可控膨胀。
3. 决策：禁止 frame 长期向量索引，最小粒度固定为 `chunk`。
4. 后果：语义细粒度下降，但成本与稳定性显著提升。
5. 验证：向量实体类型白名单测试，禁止 `frames` 入向量索引。
6. SPEC 引用：4、7、10。

### ADR-20260224-03：Cloud Failure Transparent Fallback

1. 状态：Accepted。
2. 背景：Cloud 质量提升有价值，但不能影响基础可用性。
3. 决策：Cloud 失败时自动走本地路径，保持 API 结构不变。
4. 后果：需要维护双路径一致性测试。
5. 验证：失败注入测试覆盖超时、鉴权失败、网络中断。
6. SPEC 引用：5、11、17。

### ADR-20260224-04：Citation-first Ask Output

1. 状态：Accepted。
2. 背景：Traceable AI 是产品原则，问答必须可追溯。
3. 决策：`ask` 与 Chat 输出结构强制包含 `citations[]`。
4. 后果：答案生成流程更复杂，但可验证性和可信度提升。
5. 验证：20 题样本引用可定位率 100%。
6. SPEC 引用：2、12、13、17。

## 6. 决策与测试绑定

| 决策 ID | 最低验证测试 |
| --- | --- |
| D-001 | 向量 upsert/search 基准测试 + 包体体积检查 |
| D-002 | 云向量 provider 健康检查 + fallback 集成测试 |
| D-003 | 对象存储上传下载幂等测试 + 断网回退测试 |
| D-004 | ask 输出 schema 一致性测试 + provider 切换测试 |
| D-005 | 媒体清理策略测试（30/90/365 天） |

## 7. 旧仓参考合规声明（当前轮次）

1. 当前文档阶段未读取白名单外旧仓文件。
2. 当前文档阶段未复制旧仓实现代码。
3. 后续若发生定向参考，提交说明将包含：
- `Reference:` 具体路径
- `Intent:` 参考目的
- `Rewrite:` 重写差异
- `Validation:` 验证方式

## 8. SPEC 映射

| SPEC 章节 | 本文对应位置 |
| --- | --- |
| 2 产品原则 | 1、5 |
| 5 双模式运行 | 1、5（ADR-03） |
| 7 向量策略 | 2（D-001）、5（ADR-02） |
| 8 音频策略 | 2（D-005） |
| 11 云能力 | 1、2（D-002/D-003/D-004）、5（ADR-03） |
| 12 MCP | 1、5（ADR-04 的输出契约关联） |
| 13 聊天引用 | 1、5（ADR-04） |
| 19 决策清单 | 2 全表 |
