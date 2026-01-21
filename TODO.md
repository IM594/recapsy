# TODO / 路线图（需维护）

## 维护规则（重要）

- 本文件用于记录 **RecapSense 的全部待办事项（TODO）**，包含技术债、功能计划、已知风险与阻塞项。
- **每次提交（commit）之前必须更新本文件**：
  - 把本次提交完成的事项勾选为 `- [x]`
  - 新增的 TODO 要补充背景/原因（为什么做）与最小验收标准（怎么算完成）
  - 如调整优先级，请在对应条目里注明原因（性能/隐私/成本/依赖变化等）

## 当前状态（截至本次）

- 已有最小骨架：
  - Node.js Agent（HTTP + SQLite/FTS）：`apps/agent/src/server.mjs`
  - MCP Server（stdio，工具：`recapsense_search`）：`apps/mcp/src/server.mjs`
  - 数据库迁移框架（v1 schema + v2 视觉增强预留表）：`apps/agent/src/db.mjs`
- 视觉增强（LLM Vision）已做数据库与协议占位，尚未实现 worker：`apps/agent/src/migrations/0002_vision.sql`
- 日总结默认“无声自动生成”（启发式文本摘要，后续可替换为 LLM 总结）：`apps/agent/src/store.mjs`

## P0（必须先跑通的最小闭环：截图→OCR→入库→搜索→MCP）

- [ ] 实现 macOS Collector（最小版 CLI/常驻进程）
  - 采集：每 5 秒截图（macOS 13+；当前先用 `CGDisplayCreateImage`，后续可替换为 ScreenCaptureKit）→ 下采样 → dHash 去重 → Vision OCR
  - 写入：调用 Agent `POST /v1/ingest/frame`（带 token）
  - [x] SwiftPM 可执行程序骨架：`apps/collector-macos`
  - [x] 已实现：截图 + dHash 去重 + Vision OCR + 写入 `frames` + 缩略图写盘（可关）
  - 验收：能在本机连续采集 10 分钟，`/v1/search` 与 MCP `recapsense_search` 能搜到当天内容
- [x] 证据热窗口（默认 30 天）目录规范
  - 缩略图按日期分桶（`media/thumbnails/YYYY-MM-DD/...`）
  - DB 只存相对路径或可迁移路径（避免硬编码绝对路径）
  - 已在 collector 落地：默认写入 `${RECAPSENSE_DATA_DIR}/media/thumbnails/YYYY-MM-DD/<ts>_<hash>.jpg`，并在 `frames.thumbnail_path` 存相对路径
- [x] 证据清理任务（热窗口策略落地）
  - 删除超过 30 天的 frames 与缩略图文件
  - 仅清理热证据，不影响长期 chunks/summaries（B 模式）
  - 已实现：`POST /v1/maintenance/cleanup` + 定时清理（默认每 60 分钟），并支持配置保留天数
  - 安全性：只清理已压实（`chunk_id IS NOT NULL`）的 frames，避免因为压实滞后导致数据丢失
  - 验收：可配置、可手动触发、可观察（日志/返回值）
- [x] 解决“受限环境端口监听失败（EPERM）”的运行方式（可选其一）
  - 已实现：Agent 支持 Unix Domain Socket（UDS），并可选择禁用 TCP 端口监听
  - 配置：`RECAPSENSE_AGENT_SOCKET`（默认 `${RECAPSENSE_DATA_DIR}/run/agent.sock`），`RECAPSENSE_AGENT_DISABLE_TCP=1`
  - MCP：支持通过 UDS 调用 Agent（设置同名环境变量即可）
- [x] MCP 支持 SSE（HTTP）传输（本机）
  - 用途：让 MCP 不依赖 stdio 进程管道，便于后续 UI/服务化（例如由菜单栏应用启动/托管）
  - 已实现：`apps/mcp/src/server-sse.mjs`（默认 `http://127.0.0.1:4833/sse`）
  - 安全性：要求 token（支持 `Authorization: Bearer ...` 或 `?token=...`）

## P1（长期记忆可用：压实、迁移、可控）

- [ ] 解决“FTS 模块缺失”导致的性能隐患（长期必须）
  - 背景：在部分 Node/SQLite 构建中可能缺少 `fts5/fts4`，当前已做自动降级为 LIKE（能跑通，但数据量大时会很慢）
  - 方向：评估并切换到“自带 fts5 的 SQLite 绑定/发行形态”（例如 `better-sqlite3` 或 `libsql`），或提供可控的 SQLite 构建方案
  - 验收：在目标发布环境中 `chunks_fts` 能创建成功，搜索返回稳定排序（含 score），并能在 10 万 chunks 规模下保持可用延迟
- [ ] 改进 frames→chunks 压实策略（减少重复与噪声）
  - 更稳切分：按 app/window + gap + OCR 文本变化
  - chunk 合并/更新策略（避免频繁生成碎片）
  - 验收：同一窗口连续工作 30 分钟，chunks 数量与内容合理、无大量重复段
- [ ] 做“导出/导入（换电脑）”能力（B 模式优先）
  - 导出：`chunks + daily summaries + 配置 + manifest`（热证据可选）
  - 导入：自动 migrations + 自动重建 FTS（以及后续向量索引）
  - 验收：新机器导入后，搜索与日总结可用
- [ ] 做基础设置（先简单）
  - 采集间隔（默认 5 秒）
  - 缩略图开关（默认开）
  - 热窗口天数（默认 30 天）
  - 暂停/恢复（含定时暂停）
- [ ] 数据目录约定与 macOS 推荐路径落地
  - 默认开发：`./.recapsense/`
  - 发布形态：`~/Library/Application Support/RecapSense/`
- [ ] macOS App（SwiftUI，菜单栏开关 + 主窗口：搜索/日志；UI 设计后置）
  - 目标：面向非开发用户使用时 **不需要跑命令行**；安装后打开应用即可控制采集与 MCP
  - [x] 新增 `apps/app-macos` SwiftPM 骨架（先跑通开发期 GUI）
  - [x] Supervisor：可启动/停止 Agent、MCP（SSE）、Collector，并把子进程 stdout/stderr 写入 `${RECAPSENSE_DATA_DIR}/logs/*.log`
  - [x] 修复：启动子进程时继承 PATH（避免出现 `env: node: No such file or directory`）
  - [x] 主窗口：搜索（调用 Agent `GET /v1/search`）+ 日志（展示 logs tail）
  - [x] 聊天入口占位（不实现交互）
  - 菜单栏（Menu bar）职责（先做功能，样式后置）：
    - 状态：采集中/暂停/错误（状态灯 + 简要文字）
    - 开关：开始/暂停采集（collector）
    - 开关：启动/停止 MCP（SSE）
    - 操作：打开主窗口（搜索/日志）
    - 操作：打开设置/权限指引/数据目录（后置逐步补齐）
  - 主窗口职责（先做功能，样式后置）：
    - 搜索：直接调用 Agent `GET /v1/search`
    - 日志：展示最近的 Agent/Collector/MCP 输出（最小可用即可）
    - 预留：聊天入口（先占位，不实现聊天交互）
  - 工程解耦建议（先堆好骨架，后续迭代）：
    - `apps/app-macos`：SwiftUI UI 壳（Menu bar + 主窗口）
    - `Supervisor`（UI 内部模块或独立组件）：统一管理子进程生命周期（Agent/MCP/Collector），并把日志落到 `${RECAPSENSE_DATA_DIR}/logs/`
  - 验收：首次安装后 3 分钟内可用（授权后），点击“开始采集”即可写入数据；主窗口能搜到内容；MCP SSE 可被本机客户端连接
- [ ] 发布与安装形态（面向非开发用户）
  - 目标：不要求用户预装 Node/Swift；不要求手动配置环境变量
  - 方向：notarized DMG/PKG +（可选）Sparkle 自动更新 + Launch at login
  - 技术路线候选：
    - 方案 A：逐步把 Agent/MCP 收敛到原生（Swift/Rust）以便单一二进制
    - 方案 B：继续用 Node 但打包为 app 内置 runtime（或改用 Electron/Tauri）
  - 验收：新用户安装后 3 分钟内可用（权限授权后自动开始采集）

## P2（RAG：混合检索与引用）

- [ ] Embeddings 管线（只对 chunk 级别）
  - 新增表：embeddings（记录 model/version/dim）
  - 增量计算：只对新增/变更 chunk 算 embedding
  - 验收：可对少量 chunks 计算 embedding，并可在检索中使用
- [ ] 混合检索：FTS（精确）+ 向量（语义）+ 时间过滤
  - 先做简单版：FTS 召回 TopN 后向量重排（成本低、实现快）
  - 后续再上 ANN（HNSW / 本地向量服务）
- [ ] `ask` API（本地只读）
  - 输入：问题 + 可选时间范围
  - 输出：答案 + 引用（chunk id + 时间戳 + app/window）
  - 验收：能回答“我今天主要在做什么/找某个链接”并给出处
- [ ] MCP 工具扩展（保持简单）
  - [ ] `recapsense_get_chunk`
  - [ ] `recapsense_get_daily_summary`
  - （后续）`recapsense_ask`

## P3（增强：LLM 视觉、音频、Littlebird 方向）

- [ ] 视觉增强 worker（策略性触发，不对每帧调用）
  - jobs：写 `vision_jobs`（预算/重试/黑名单/白名单）
  - extractions：写 `vision_extractions`（长期保存可检索文本 + JSON）
  - 验收：对每个 chunk 选 1 张关键帧做抽取，搜索可命中抽取文本
- [ ] 音频（mic + 可选系统音频）
  - mic：VAD 分段 + 云端 ASR（先快）
  - 系统音频：优先 ScreenCaptureKit（macOS 13+），否则提供回环设备方案
- [ ] 更贴近 Littlebird 的 text-first（后续可替换截图 OCR）
  - Accessibility（AX）读取可见文本
  - 浏览器扩展提供 URL/DOM 文本（域名黑名单）

## 安全与隐私（贯穿所有阶段）

- [ ] App/域名黑名单（默认排除敏感场景）
- [ ] “危险区域”删除：删除最近 1 小时/1 天/全部
- [ ] 加密策略（至少导出包加密；本地加密可后置）
- [ ] 对外接口默认只绑定本机（127.0.0.1 或 UDS），并强制 token
