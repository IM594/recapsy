# RecapSense 项目概念清单（学习用）

> 目标：把本仓库 **实际用到**（以及已在协议/数据库中预留）的关键概念按主题归类，方便你按图索骥学习与查代码。  
> 说明：本文档偏“概念目录 + 指路”，不是完整教程；每个概念都尽量给出对应的代码/文件入口。

## 0. 一句话理解这个项目

RecapSense 是一个 **本地、全天候运行的“记忆”管线**：  
**屏幕截图 → OCR → 写入 frames（短期热证据） → 压实成 chunks（长期文本） → 搜索/RAG → 通过 HTTP API 与 MCP 暴露给外部工具/LLM。**

核心入口：

- 总览：`README.md`
- Agent（后端）：`apps/agent/README.md`、`apps/agent/src/server.mjs`
- MCP（工具入口）：`apps/mcp/README.md`、`apps/mcp/src/server.mjs`、`apps/mcp/src/server-sse.mjs`
- 采集端（macOS）：`apps/collector-macos/README.md`、`apps/collector-macos/Sources/RecapSenseCollector/Entry.swift`
- 菜单栏 App（macOS）：`apps/app-macos/README.md`、`apps/app-macos/Sources/RecapSenseApp/`

---

## 1. 业务/产品层概念（“这个系统在做什么”）

### 1.1 本地记忆（Personal Memory）

- **本机优先**：所有数据默认只在本机落盘，不面向公网服务。
- **可检索的长期文本**：把人类行为痕迹压实成“可搜索/可引用”的文本片段（chunks）。
- **可追溯的证据**：在短时间窗口内保留截图/缩略图等“热证据”，长期仅保留文本（隐私/成本更可控）。

### 1.2 “B 模式”留存模型（长期文本 + 热窗口证据）

在 `README.md` / `TODO.md` 里明确的策略：

- **长期保存**：`chunks`、`daily summaries`、（预留）视觉抽取文本等。
- **热窗口证据**：截图/缩略图等媒体文件，只保留有限天数（默认 30 天，可配置），可清理。
- **派生索引可重建**：FTS（全文索引）以及未来 embeddings/向量索引属于“派生”，可重建，不强依赖。

相关入口：

- 数据目录约定：`README.md`（`.recapsense/` 与 `~/Library/Application Support/RecapSense/`）
- 清理逻辑：`apps/agent/src/server.mjs`（`cleanupEvidence`、`deleteMediaDirectory`）
- 数据表：`apps/agent/src/schema.sql`、`apps/agent/src/migrations/0002_vision.sql`

### 1.3 关键数据对象：Frame / Chunk / Daily Summary

- **Frame**：一次采集得到的 OCR 帧（粒度较细，体量大，可短期保留）
  - 典型字段：时间戳、app/windowTitle、OCR 文本、（可选）截图/缩略图路径、感知哈希等
  - 表：`frames`（`apps/agent/src/schema.sql`）
- **Chunk**：压实后的长期“记忆片段”（粒度更粗，长期可用）
  - 通常由多个 frames 合并、清洗、去噪得到
  - 表：`chunks`（`apps/agent/src/schema.sql`）
- **Daily Summary**：按日聚合的总结文本（当前为 heuristic 版本）
  - 表：`summaries_daily`（`apps/agent/src/schema.sql`）
  - 生成：`apps/agent/src/store.mjs`（`generateDailySummary` / `ensureDailySummary`）

---

## 2. 架构与组件拆分（“谁负责什么”）

### 2.1 Agent（Node.js 本地服务）

定位：本地后端，负责存储、检索、压实、清理、对外 API。

核心概念：

- **Node.js 运行时与模块系统**
  - Node 版本：`>=22`（仓库要求）
  - ESM：`"type": "module"`，代码使用 `import ... from "node:xxx"` 的内置模块写法
  - 依赖策略：尽量只用 Node 内置能力（减少部署复杂度）
  - 入口：根 `package.json`、`apps/agent/package.json`
- **HTTP API（本机）**：`node:http` 自建最小服务，路径以 `/v1/*` 为主。
- **SQLite 存储**：frames/chunks/summaries/settings 等都在本地 SQLite。
- **压实（Compaction）**：后台定时把 frames 聚合成 chunks。
- **全文检索（FTS）**：优先使用 SQLite FTS5/FTS4；不可用时自动降级 `LIKE`。
- **证据清理**：基于 retentionDays 清理“已压实”的旧 frames 与对应文件。
- **危险区域删除（Danger Zone）**：按范围/最近/全部删除数据（不可恢复）。

入口：

- `apps/agent/src/server.mjs`
- `apps/agent/src/store.mjs`
- `apps/agent/src/db.mjs`

### 2.2 Collector（macOS 原生采集进程）

定位：抓屏 + OCR + 去重 + 写入 Agent（frames）。

核心概念：

- **屏幕/窗口截图**：CoreGraphics（`CGWindowListCreateImage` 等）
- **OCR**：Vision（`VNRecognizeTextRequest`）
- **去重**：dHash + 汉明距离（减少重复 OCR/重复入库）
- **缩略图写盘**：ImageIO 写 JPEG 到 dataDir/media
- **macOS 权限**：屏幕录制、辅助功能（窗口标题）

入口：

- `apps/collector-macos/Sources/RecapSenseCollector/Entry.swift`
- `apps/collector-macos/Sources/RecapSenseCollector/ScreenCapture.swift`
- `apps/collector-macos/Sources/RecapSenseCollector/OCR.swift`

### 2.3 MCP Server（本机工具入口）

定位：把 RecapSense 的只读能力以 MCP 协议暴露给外部客户端（例如 Claude Desktop）。

核心概念：

- **MCP 协议的工具（tools）**：例如 `recapsense_search`
- **JSON-RPC 2.0**：MCP 的消息形态（initialize/tools/list/tools/call…）
- **两种传输**：
  - stdio：进程型集成（行分隔 JSON）
  - SSE（HTTP）：本机 HTTP 集成（`/sse` + `/message`）

入口：

- `apps/mcp/src/mcp-core.mjs`
- `apps/mcp/src/server.mjs`
- `apps/mcp/src/server-sse.mjs`

### 2.4 macOS 菜单栏 App（SwiftUI 外壳）

定位：面向用户的控制台：启动/停止 Agent/MCP/Collector，提供搜索/日总结/日志/设置 UI。

核心概念：

- **进程托管（Supervisor）**：统一管理子进程生命周期、日志落盘
- **单实例保护**：避免重复启动导致端口占用/状态错乱
- **窗口管理**：主窗口单例、Dock 行为符合 macOS 直觉

入口：

- `apps/app-macos/Sources/RecapSenseApp/Supervisor/Supervisor.swift`
- `apps/app-macos/Sources/RecapSenseApp/Supervisor/ManagedProcess.swift`
- `apps/app-macos/Sources/RecapSenseApp/App/SingleInstanceLock.swift`

---

## 3. 数据与存储（SQLite / 数据目录 / 迁移）

### 3.1 SQLite 基础概念

项目里用到的 SQLite 概念包括：

- **Node 内置 SQLite 绑定**：`node:sqlite`（`DatabaseSync`），在部分环境会看到 ExperimentalWarning（不影响功能）
- **表（tables）/索引（indexes）/外键（foreign_keys）**
- **WAL 模式**：写入并发更友好（`PRAGMA journal_mode=WAL;`）
- **同步级别**：`PRAGMA synchronous=NORMAL;`（性能/安全折中）
- **迁移（migrations）**：用 `PRAGMA user_version` 管理 schema 版本
- **事务（transaction）**：`BEGIN IMMEDIATE`（抢写锁，保证一致性）

入口：`apps/agent/src/db.mjs`

### 3.2 数据表（Schema）

当前 schema（MVP）：

- `frames`：短期 OCR 帧（可含热证据路径）
- `chunks`：长期文本片段
- `summaries_daily`：日总结

入口：`apps/agent/src/schema.sql`

额外迁移：

- `settings`：用户设置（长期状态）
  - 入口：`apps/agent/src/migrations/0003_settings.sql`
- `vision_jobs` / `vision_extractions`：视觉增强的任务与产物（预留，暂不启用）
  - 入口：`apps/agent/src/migrations/0002_vision.sql`
- `thumbnailMaxWidth` 默认值升级（迁移只改旧默认，不覆盖用户自定义）
  - 入口：`apps/agent/src/migrations/0004_thumbnail_width.sql`

### 3.3 数据目录（Data Dir）与可迁移性

概念：

- **dataDir**：RecapSense 的所有本地状态根目录
  - 开发默认：`./.recapsense/`（仓库内，便于调试）
  - 推荐（发布形态）：`~/Library/Application Support/RecapSense/`
- **目录分层**（约定）：
  - `db/recapsense.db`：SQLite
  - `secret/token`：API token（本机访问）
  - `media/`：热证据（缩略图等，可整体删）
  - `logs/`：日志（agent/mcp/collector）
  - `run/`：运行期文件（例如 app lock、socket）

入口：

- Node：`apps/agent/src/paths.mjs`、`apps/agent/src/secrets.mjs`
- Swift：`apps/collector-macos/Sources/RecapSenseCollector/Paths.swift`、`apps/app-macos/Sources/RecapSenseApp/Supervisor/SupervisorConfig.swift`

### 3.4 ID：ULID（可按时间排序的唯一 ID）

概念：

- **ULID**：与 UUID 类似，但可按字典序大致反映时间先后，适合时间线数据。
- 本项目用 ULID 给 chunk 生成 id（以 startTs 为时间种子）。

入口：`apps/agent/src/ids.mjs`、`apps/agent/src/store.mjs`（`ulid(first.ts)`）

---

## 4. 检索与文本处理（FTS / 清洗 / 压实）

### 4.1 SQLite FTS（全文索引）

概念：

- **FTS5/FTS4 虚拟表**：用于全文检索（`CREATE VIRTUAL TABLE ... USING fts5/fts4`）
- **兼容性处理**：不同环境的 SQLite 可能缺少 fts5/fts4，项目采取“尽力而为 + 自动降级”策略。
- **降级策略**：FTS 不可用时，用 `LIKE` 做最小可用搜索（慢，但能跑通闭环）。

入口：

- 创建与回填：`apps/agent/src/db.mjs`（`ensureChunksFts`）
- 使用与降级：`apps/agent/src/store.mjs`（`searchChunks`）

### 4.2 OCR 文本清洗（去噪/规整）

概念：

- **normalizeText**：统一换行、空白、trim
- **低信号行过滤**：过滤菜单栏/侧边栏固定 UI、乱码符号块、纯数字徽标等
- **“怪字符”比例**：用汉字/ASCII 统计粗略识别 OCR 噪声

入口：`apps/agent/src/store.mjs`（`cleanOcrLinesForChunk` 等）

### 4.3 frames → chunks 压实（Compaction）

概念：

- **分组键**：通常按 `app + window_title` 分组（避免跨上下文混合）
- **时间切分**：
  - `maxGapMs`：两帧间隔过大则切分
  - `maxChunkDurationMs`：chunk 最长持续时间
- **跨帧去重 + 高频短行过滤**：
  - 先按帧清洗得到 lines
  - 统计“高频出现”的短行（侧边栏/菜单等固定 UI），在帧数足够时过滤
  - 组装时保持顺序、跨帧去重（减少重复内容）

入口：`apps/agent/src/store.mjs`（`compactFramesToChunks`）

### 4.4 维护能力：recleanChunks（规则升级后清理历史）

概念：

- 当 OCR 清洗规则升级后，历史 chunks 的文本仍是旧规则生成的。
- `recleanChunks` 会对历史 chunks 就地重写 text，并尽力更新 FTS，让搜索结果“立刻变干净”。

入口：

- 逻辑：`apps/agent/src/store.mjs`（`recleanChunks`）
- API：`apps/agent/src/server.mjs`（`POST /v1/maintenance/reclean-chunks`）

---

## 5. 通信与协议（HTTP / 鉴权 / UDS / MCP / SSE）

### 5.1 本机 HTTP API（Agent）

概念：

- **健康检查**：`GET /health`（无需鉴权）
- **业务 API**：`/v1/*`（需要 token）
- **JSON 请求体读取与大小限制**：防止大 body 撞爆内存

入口：`apps/agent/src/server.mjs`、`apps/agent/src/http.mjs`

### 5.2 Bearer Token 鉴权（本机接口）

概念：

- 请求头：`Authorization: Bearer <token>`
- token 默认写入 `${DATA_DIR}/secret/token`，权限 `0600`
- 环境变量可覆盖：`RECAPSENSE_API_TOKEN`

入口：

- token 生成：`apps/agent/src/secrets.mjs`
- token 校验：`apps/agent/src/http.mjs`
- MCP/Collector/UI 读取 token：`apps/mcp/src/token.mjs`、`apps/collector-macos/.../Paths.swift`、`apps/app-macos/.../AgentHttpClient.swift`

### 5.3 Unix Domain Socket（UDS，本机更隔离的通信）

概念：

- Agent 可同时监听 TCP（127.0.0.1）与 UDS（socket 文件）。
- MCP 优先走 UDS（更本机、更难误暴露）。
- Collector（Swift URLSession）不支持 UDS，所以仍走 TCP。

入口：

- Agent 监听：`apps/agent/src/server.mjs`（`RECAPSENSE_AGENT_SOCKET`、`RECAPSENSE_AGENT_DISABLE_TCP`）
- MCP 走 UDS：`apps/mcp/src/mcp-core.mjs`（`http.request({ socketPath })`）

### 5.4 MCP（Model Context Protocol）与 JSON-RPC 2.0

概念：

- **JSON-RPC**：消息含 `jsonrpc/id/method/params`
- **MCP 生命周期**：
  - `initialize`
  - `tools/list`
  - `tools/call`
  - `notifications/initialized`（通知，无 id，通常忽略）
- **工具声明**：包含 name/description/inputSchema/annotations（readOnlyHint 等）

入口：`apps/mcp/src/mcp-core.mjs`

### 5.5 SSE（Server-Sent Events）作为 MCP 传输

概念：

- `Content-Type: text/event-stream`
- 服务器主动推送事件：
  - `event: endpoint`：告诉客户端应该 POST 到哪个 message endpoint
  - `event: message`：把 JSON-RPC 响应推回去
- keepalive：定期写 `: keepalive ...` 避免连接空闲被中间层断开
- 多会话：用 `sessionId` 路由到不同 SSE 连接

入口：`apps/mcp/src/server-sse.mjs`

---

## 6. macOS 采集端（屏幕截图 / OCR / 去重 / 权限）

### 6.1 屏幕截图：CGWindowList / CGDisplay

概念：

- **前台窗口优先**：尽量截“用户真正关注的窗口区域”，减少全屏噪声
- **多级降级**：
  1) 直接按 windowID 截图
  2) 退化为 bounds 裁剪
  3) 再降级为全屏截图（保证至少有数据）
- **元数据矫正**：裁剪模式下容易出现 app/title 与 OCR 内容错配，需要做“探点反查”纠正

入口：`apps/collector-macos/Sources/RecapSenseCollector/ScreenCapture.swift`

### 6.2 macOS 权限（TCC）

概念：

- **屏幕录制权限**：没有就无法截屏
  - `CGPreflightScreenCaptureAccess()`
  - `CGRequestScreenCaptureAccess()`
- **辅助功能权限（可选）**：用于读取窗口标题（AX API）
  - `AXIsProcessTrusted()` 等

入口：

- 屏幕录制：`apps/collector-macos/.../Entry.swift`
- 辅助功能：`apps/collector-macos/.../AppContext.swift`
- UI 打开系统设置入口：`apps/app-macos/.../SettingsView.swift`

### 6.3 OCR：Vision VNRecognizeTextRequest

概念：

- **识别等级**：fast / accurate（速度 vs 质量）
- **语言列表**：例如 `zh-Hans`、`en-US`
- **语言纠错**：accurate 时启用，fast 时关闭（减少对代码/命令的“纠错过度”）
- **版面排序**：按 boundingBox 从上到下、从左到右排序，提升可读性
- **置信度过滤**：丢弃置信度极低的片段，减少乱码

入口：`apps/collector-macos/Sources/RecapSenseCollector/OCR.swift`

### 6.4 OCR 质量评估与自适应策略

概念：

- 基于“好字符/怪字符”比例做粗评分（不是语义评分）
- fast 输出明显低信号时，自动追加一次 accurate，并选择更好的结果

入口：`apps/collector-macos/Sources/RecapSenseCollector/OCR.swift`、`Entry.swift`

### 6.5 去重：dHash + 汉明距离

概念：

- **dHash**：把图缩到 9×8 灰度，比较相邻像素亮度得到 64bit
- **汉明距离**：两次 hash 的 bit 差异数；小于阈值认为“几乎同图”
- **额外去重**：OCR 文本完全未变化时也跳过写入

入口：`apps/collector-macos/Sources/RecapSenseCollector/ImageHash.swift`、`Entry.swift`

### 6.6 缩略图（热证据）写盘

概念：

- resize：缩放到最大宽度（默认 720px，可配置）
- JPEG 写入：ImageIO（`CGImageDestination`）
- 路径写入 DB：Agent 存相对路径（便于迁移）

入口：

- 写 JPEG：`apps/collector-macos/Sources/RecapSenseCollector/ImageIO.swift`
- 路径：`apps/collector-macos/Sources/RecapSenseCollector/Paths.swift`

### 6.7 运行时稳定性：信号/父进程监控/日志轮转

概念：

- SIGINT/SIGTERM：优雅退出（GCD DispatchSourceSignal）
- 父进程消失自动退出：`RECAPSENSE_PARENT_PID` + `kill(pid, 0)`（避免孤儿进程占资源）
- OCR 全文日志轮转：超过上限移动为 `.1`（高隐私/高体量，默认不启用或谨慎启用）

入口：

- 信号：`apps/collector-macos/.../StopController.swift`
- OCR 日志：`apps/collector-macos/.../OcrDebugLog.swift`

---

## 7. macOS 菜单栏 App（SwiftUI + 进程托管 + UI）

### 7.1 SwiftUI / AppKit 桥接

概念：

- `@main App` + `@NSApplicationDelegateAdaptor`：同时使用 SwiftUI 与 AppKit 生命周期
- MenuBarExtra：菜单栏入口
- 主窗口手动管理：保持单实例、Dock 点击行为一致、关闭=隐藏保留状态

入口：

- 菜单栏入口：`apps/app-macos/Sources/RecapSenseApp/RecapSenseApp.swift`
- AppDelegate：`apps/app-macos/Sources/RecapSenseApp/App/AppDelegate.swift`
- 主窗口控制：`apps/app-macos/Sources/RecapSenseApp/Window/MainWindowController.swift`

### 7.2 进程托管（Supervisor / ManagedProcess）

概念：

- 用 `Process` 启动/停止子进程（Agent/MCP/Collector）
- stdout/stderr 重定向到同一日志文件（最稳、最简单）
- terminationHandler：更新 UI 状态（running/exited/failed）
- stop 策略：先 `terminate()`，超时兜底 `SIGKILL`（避免端口残留）
- 外部进程探测：通过 `/health` 判断“端口上已有服务”，避免重复拉起第二实例

入口：

- `apps/app-macos/Sources/RecapSenseApp/Supervisor/Supervisor.swift`
- `apps/app-macos/Sources/RecapSenseApp/Supervisor/ManagedProcess.swift`

### 7.3 单实例锁（文件锁）

概念：

- SwiftPM 可执行程序形态下 macOS 不会自动单实例复用
- 使用 `fcntl(F_SETLK)` 对 lock 文件加非阻塞写锁（并写入 pid 便于排障）

入口：`apps/app-macos/Sources/RecapSenseApp/App/SingleInstanceLock.swift`

### 7.4 Node 可执行文件探测与 PATH 补齐

概念：

- Finder/LaunchAgent 启动时 PATH 可能很“瘦”，导致找不到 node
- 通过：
  - 常见稳定路径优先（Homebrew）
  - 必要时补齐 PATH（nvm/asdf/mise/volta 等）
  - 环境变量覆盖（`RECAPSENSE_NODE_BIN`）

入口：`apps/app-macos/Sources/RecapSenseApp/Supervisor/SupervisorConfig.swift`

### 7.5 UI 功能点对应的概念

- 搜索 UI：输入 query + limit，左侧列表，右侧详情（`NavigationSplitView`）
  - `apps/app-macos/Sources/RecapSenseApp/Views/SearchView.swift`
- 日总结 UI：按日期选择，加载/生成（`DatePicker` + `ProgressView`）
  - `apps/app-macos/Sources/RecapSenseApp/Views/DailySummaryView.swift`
- 日志 UI：读 tail + 一键复制 + 打开日志目录（便于排障）
  - `apps/app-macos/Sources/RecapSenseApp/Views/LogsView.swift`
- 设置 UI：settings 读写、黑名单、Danger Zone、打开系统权限设置页
  - `apps/app-macos/Sources/RecapSenseApp/Views/SettingsView.swift`

---

## 8. 配置与运行（环境变量 / npm scripts / SwiftPM）

### 8.1 环境变量（核心）

跨组件共享的概念：

- `RECAPSENSE_DATA_DIR`：数据目录
- `RECAPSENSE_AGENT_URL`：Agent HTTP 地址（默认 `http://127.0.0.1:4832`）
- `RECAPSENSE_API_TOKEN`：直接提供 token（可覆盖 token 文件读取）
- `RECAPSENSE_AGENT_SOCKET`：启用/指定 UDS socket 路径（Agent/MCP）
- `RECAPSENSE_AGENT_DISABLE_TCP=1`：Agent 仅监听 UDS
- `RECAPSENSE_PARENT_PID`：父进程 pid（用于 watchdog，避免孤儿进程）

入口：`README.md`、`apps/agent/README.md`、`apps/mcp/README.md`

### 8.2 npm scripts（开发期一键跑）

概念：

- monorepo workspaces：`package.json`（`apps/*`）
- Node 运行要求：`node >= 22`（并启用内置 `fetch`、`node:sqlite` 等能力）
- 一条命令拉起多个服务（Agent + MCP SSE）：`scripts/dev.mjs`
- 采集端辅助脚本：`scripts/collector.mjs`（自动 build + run）

入口：根 `package.json`、`scripts/dev.mjs`、`scripts/collector.mjs`

### 8.3 SwiftPM（构建 macOS 可执行程序）

概念：

- Swift Package Manager（无第三方依赖，直接用系统框架）
- 最低 macOS 13

入口：`apps/app-macos/Package.swift`、`apps/collector-macos/Package.swift`

### 8.4 测试与种子数据（开发期）

概念：

- **Node 内置测试框架**：`node:test` + `node --test`（无需 Jest/Vitest）
  - 入口：`apps/agent/test/store.test.mjs`
  - 脚本：根 `package.json`、`apps/agent/package.json`、`apps/mcp/package.json`
- **Seed（插入 demo 数据）**：用于快速验证搜索/FTS/MCP 闭环
  - 入口：`apps/agent/src/seed.mjs`（`npm run seed`）

---

## 9. 安全、隐私与稳定性（工程化“细节概念”）

### 9.1 本机隔离与最小暴露面

概念：

- 默认只监听 `127.0.0.1` 或 UDS（减少误暴露）
- `/v1/*` 强制 token，`/health` 无需鉴权（便于探活）

入口：`apps/agent/src/server.mjs`

### 9.2 数据删除的安全边界（Path Traversal 防护）

概念：

- 证据文件删除只接受 **相对路径**，并且必须落在 dataDir 下
- 防止误删任意绝对路径或通过 `../` 逃逸

入口：`apps/agent/src/server.mjs`（`resolveSafePath`）

### 9.3 “只清理已压实 frames” 的防数据丢失原则

概念：

- 清理任务只删除 `chunk_id IS NOT NULL` 的 frames（说明它们已被压实进 chunks）
- 避免删掉还没进入 chunks 的原始证据导致“文本记忆丢失”

入口：`apps/agent/src/store.mjs`（`deleteExpiredEvidenceFrames` 查询条件）

### 9.4 多实例/端口残留治理

概念：

- Agent 启动前探测 `/health`，已有服务则退出（避免多实例写同一 DB）
- 子进程父进程 watchdog：父进程消失自动退出
- UI 退出时 stopAllAndWait：避免端口占用导致下次启动失败

入口：

- `apps/agent/src/server.mjs`（detectExistingAgent / parent watchdog）
- `apps/mcp/src/server*.mjs`（parent watchdog）
- `apps/collector-macos/.../Entry.swift`（parent watchdog）
- `apps/app-macos/.../Supervisor.swift`、`AppDelegate.swift`

---

## 10. 预留/未来扩展方向（已在仓库中出现的概念）

这些概念在 `README.md` / `TODO.md` / migrations 中已经出现，但可能尚未完全实现：

- **Embeddings + 混合检索**：FTS + 向量重排 + 时间过滤（RAG 的检索层）
- **Vision Enrichment（视觉增强）**：
  - `vision_jobs`：任务调度/重试/预算
  - `vision_extractions`：抽取产物（长期文本 + JSON）
- **更多 MCP 工具**：例如 get_chunk / get_daily_summary / ask

入口：

- `TODO.md`
- `apps/agent/README.md`（预留端点/数据对象）
- `apps/agent/src/migrations/0002_vision.sql`

---

## 11. 建议学习路线（从易到难）

1. 先读 `README.md`，理解“管线”和 B 模式留存模型  
2. 读 Agent：`apps/agent/README.md` → `apps/agent/src/server.mjs` → `apps/agent/src/store.mjs`（理解 schema/FTS/压实/清理）  
3. 读 Collector：`apps/collector-macos/.../Entry.swift`（理解抓屏/OCR/去重/权限）  
4. 读 MCP：`apps/mcp/README.md` → `apps/mcp/src/mcp-core.mjs`（理解 MCP/JSON-RPC/SSE）  
5. 最后读 macOS App：`apps/app-macos/.../Supervisor.swift`（理解进程托管、日志、单实例、UI）  

---

## 12. 快速检索关键词（你想在代码里找什么）

用 `rg`（ripgrep）搜索这些关键词会很高效：

- 组件入口：`server.mjs` / `server-sse.mjs` / `Entry.swift` / `Supervisor.swift`
- 鉴权：`Authorization`、`Bearer`、`token`
- 数据库：`DatabaseSync`、`PRAGMA`、`chunks_fts`、`fts5`、`user_version`
- 压实：`compactFramesToChunks`
- 清理：`cleanupEvidence`、`deleteExpiredEvidenceFrames`、`danger`
- UDS：`RECAPSENSE_AGENT_SOCKET`、`socketPath`
- MCP：`tools/list`、`tools/call`、`jsonrpc`
- SSE：`text/event-stream`、`event: endpoint`、`keepalive`
- macOS 权限：`CGPreflightScreenCaptureAccess`、`AXIsProcessTrusted`
- OCR：`VNRecognizeTextRequest`、`recognitionLevel`
