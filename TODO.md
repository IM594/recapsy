# TODO / 路线图（需维护）

## 维护规则（重要）

- 本文件用于记录 **RecapSense 的全部待办事项（TODO）**，包含技术债、功能计划、已知风险与阻塞项。
- **每次提交（commit）之前必须更新本文件**：
  - 把本次提交完成的事项勾选为 `- [x]`
  - 新增的 TODO 要补充背景/原因（为什么做）与最小验收标准（怎么算完成）
  - 如调整优先级，请在对应条目里注明原因（性能/隐私/成本/依赖变化等）

## 项目约束（不轻易改变）

- 平台：只做 macOS，最低支持 13+。
- 本机优先：默认只监听 `127.0.0.1`（或 UDS），对外网开放后置；所有 `/v1/*` 强制 token。
- 采集默认：每 5 秒一帧（可配置），必须去重。
- 留存模型：B 模式
  - 长期保存：`chunks` / `daily summaries` /（未来）视觉抽取文本
  - 热窗口证据：截图/音频（默认 30 天，可配置，可清理）
- 文档与注释用中文；代码标识符/API/tool 名用英文。

## 当前状态（M0：闭环已跑通，可日常使用）

- 数据管线已跑通：`collector → agent(frames) → compaction(chunks) → search → mcp`
- macOS UI 已可控：
  - 菜单栏开关：启动/停止 Agent、MCP(SSE)、Collector
  - 主窗口：搜索（含 chunk 详情）/日总结/日志/设置（聊天占位）
- 设置已落库（SQLite `settings` 表）并有 API：`GET/PATCH /v1/settings`
- 已知“噪音”：Node 内置 `sqlite` 的 ExperimentalWarning（不影响功能，后续发布形态会消除）

## 当前阻塞 / 已知问题（P0：先修这些再扩功能）

- [ ] macOS UI：主窗口应为单例（重复点击“打开主窗口”不应弹出多个）
  - 背景：现在可能出现多个窗口，用户体验差，也会让后续“聊天窗口/搜索窗口”难以管理。
  - 验收：无论点多少次，只会聚焦到同一个主窗口；关闭窗口后再次打开仍是同一个窗口实例（或重新创建但保持单例语义）。
- [ ] macOS UI：Dock 图标行为符合直觉（可点开/切换/最小化）
  - 背景：当前 SwiftPM 可执行程序的 Dock 交互不符合 macOS 习惯，影响“非开发用户”的使用。
  - 验收：Dock 图标点击可显示主窗口；主窗口可最小化并从 Dock 恢复；从 Dock 关闭窗口不退出菜单栏常驻。
- [x] macOS UI：退出时必须清理子进程，避免端口残留（`EADDRINUSE`）
  - 背景：MCP SSE 端口（默认 4833）残留会导致下次启动失败。
  - 验收：退出/重启 App 后可立刻再次启动 MCP；不存在需要手动 kill 的常态流程。
- [x] macOS UI：启动 Agent/MCP 不应依赖 PATH，修复 `env: node: No such file or directory`
  - 背景：从 .app/LaunchAgent 启动时环境变量不完整，`node`（尤其 nvm）经常找不到。
  - 验收：UI 启动服务稳定（Homebrew/nvm 场景都可用）；若仍找不到，要给出明确的可操作提示（配置 Node 路径）。
- [x] Collector：屏幕录制权限提示更精确（告诉用户该给谁授权）
  - 背景：Collector 可能由 Warp 启动，也可能由菜单栏 App 启动；授权对象不同会让人困惑。
  - 验收：错误信息能明确指出“当前采集进程是谁启动的”；并在 UI 中提供“打开系统设置 → 屏幕录制”的入口（后续做）。
- [x] Collector：尽量避免“重编译导致屏幕录制权限失效”
  - 背景：直接运行 `.build/...` 产物时，macOS 可能把重编译后的二进制视作“新程序”，导致屏幕录制权限失效。
  - 验收：菜单栏 App 优先运行 `${DATA_DIR}/bin/recapsense-collector`（稳定路径），减少反复授权。

## 近期计划（Plan：建议的接下来 1~2 个迭代）

> 目标：让它能“放心全天候跑”，同时确保“换电脑/备份”不痛苦。

- [ ] M1-0 稳定性收尾（先把 P0 清干净）
  - 背景：先把“运行稳定+符合直觉”打磨好，后续功能才不会越堆越乱。
  - 验收：P0 列表全部完成，开发期基本不需要手动 kill/重启来救场。
- [x] M1-1 暂停/恢复采集（含定时暂停）
  - 背景：需要在敏感场景快速暂停（会议/密码/隐私页面）。
  - 验收：菜单栏可一键暂停/恢复；支持“暂停 15 分钟/1 小时”；暂停期间不会写入 frames。
- [x] M1-2 App 黑名单（先做应用，域名后置）
  - 背景：用户应能明确排除某些应用（例如密码管理器/银行/私聊）。
  - 验收：可在设置页维护 appName 列表；collector 遇到黑名单应用直接跳过采集。
- [x] M1-3 “危险区域（Danger Zone）”删除
  - 背景：需要随时删除最近的记录（最近 1 小时/1 天/全部）。
  - 验收：UI 可点按钮删除；支持同时删 chunks 与热证据；删除后搜索不再出现。
- [ ] M2-1 导出/导入（换电脑）
  - 背景：长期几十年数据，必须可迁移。
  - 验收：可导出 `db + settings + manifest`；导入后可直接搜索/日总结可用（热证据可选）。

## Milestone M0（已完成）：最小闭环（截图→OCR→入库→搜索→MCP）

- [x] macOS Collector（SwiftPM 可执行程序）
  - 采集：截图 → dHash 去重 → Vision OCR
  - 写入：`POST /v1/ingest/frame`（带 token）
  - 验收：本机连续采集 10 分钟，`/v1/search` 能搜到当天内容
- [x] 证据热窗口目录规范（默认 30 天）
  - 缩略图按日期分桶：`media/thumbnails/YYYY-MM-DD/...`
  - DB 存相对路径（可迁移）
- [x] 证据清理任务（热窗口策略落地）
  - `POST /v1/maintenance/cleanup` + 定时清理
  - 只清理已压实（`chunk_id IS NOT NULL`）的 frames
- [x] Agent 支持 UDS（可选）+ MCP 支持走 UDS
  - `RECAPSENSE_AGENT_SOCKET`，`RECAPSENSE_AGENT_DISABLE_TCP=1`
- [x] MCP 支持 SSE（HTTP，本机）
  - `apps/mcp/src/server-sse.mjs`（默认 `http://127.0.0.1:4833/sse`）

## Milestone M1（进行中）：可控 + 隐私（能放心全天候跑）

- [x] 设置落库（SQLite `settings`）+ API：`GET/PATCH /v1/settings`
- [x] macOS UI：设置页可修改采集间隔/去重/缩略图/证据保留等，并可重启 collector 应用
- [x] 暂停/恢复（含定时暂停）
- [x] App 黑名单（先 App）
- [ ] 域名黑名单（后置：浏览器 URL/扩展）
- [x] “危险区域”删除：最近 1 小时/1 天/全部

## Milestone M2（待做）：迁移/备份 + 发布形态（面向非开发用户）

- [ ] 数据目录约定与 macOS 推荐路径落地
  - 默认开发：`./.recapsense/`
  - 发布形态：`~/Library/Application Support/RecapSense/`
- [ ] 导出/导入（换电脑，B 模式优先）
  - 导出：`chunks + daily summaries + settings + manifest`（热证据可选）
  - 导入：自动 migrations + 自动重建 FTS（以及后续向量索引）
- [ ] 加密策略（先保守可用，后续增强）
  - 导出包加密（至少密码/密钥保护）
  - 本地静态加密后置（优先保证可迁移与可重建索引）
- [ ] 发布与安装形态（面向非开发用户）
  - 目标：不要求用户预装 Node/Swift；不要求手动配置环境变量
  - 方向：notarized DMG/PKG +（可选）Sparkle 自动更新 + Launch at login
  - 技术路线候选：
    - 方案 A：逐步把 Agent/MCP 收敛到原生（Swift/Rust）以便单一二进制
    - 方案 B：继续用 Node 但打包为 app 内置 runtime（或改用 Electron/Tauri）

## Milestone M3（待做）：RAG（混合检索 + 引用）

- [ ] Embeddings 管线（只对 chunk 级别）
  - 增量计算：只对新增/变更 chunk 算 embedding
- [ ] 混合检索：FTS（精确）+ 向量（语义）+ 时间过滤
  - 先做简单版：FTS 召回 TopN 后向量重排
  - 后续再上 ANN（HNSW / 本地向量服务）
- [ ] `ask` API（本地只读）
  - 输出：答案 + 引用（chunk id + 时间戳 + app/window）
- [ ] MCP 工具扩展（保持简单）
  - [ ] `recapsense_get_chunk`
  - [ ] `recapsense_get_daily_summary`
  - （后续）`recapsense_ask`

## Milestone M4（待做）：增强（LLM 视觉、音频、Littlebird 方向）

- [ ] 视觉增强 worker（策略性触发，不对每帧调用）
  - jobs：写 `vision_jobs`（预算/重试/黑名单/白名单）
  - extractions：写 `vision_extractions`（长期保存可检索文本 + JSON）
- [ ] 音频（mic + 可选系统音频）
  - mic：VAD 分段 + 云端 ASR（先快）
  - 系统音频：优先 ScreenCaptureKit（macOS 13+），否则提供回环设备方案
- [ ] 更贴近 Littlebird 的 text-first（后续可替换 screenshot+OCR）
  - Accessibility（AX）读取可见文本
  - 浏览器扩展提供 URL/DOM 文本（域名黑名单）

## 技术债 / 风险（不做会影响长期）

- [ ] 解决“FTS 模块缺失”导致的性能隐患（长期必须）
  - 背景：部分 Node/SQLite 构建缺少 `fts5/fts4`，当前已降级 LIKE（能跑通，但规模大后会慢）
  - 方向：评估 `better-sqlite3` / `libsql` 或可控 SQLite 构建方案
  - 验收：10 万 chunks 规模可用延迟（且排序稳定，含 score）
- [ ] 改进 frames→chunks 压实策略（减少重复与噪声）
  - 更稳切分：按 app/window + gap + OCR 文本变化
  - chunk 合并/更新策略（避免碎片化）
