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

- [x] 日志：所有服务日志需带时间戳（便于区分本次/上次运行）
  - 背景：当前日志只有内容没有时间，重启后很难判断某条 log 属于哪次运行，也不利于排障。
  - 验收：Agent/MCP/Collector 的每行日志都包含本地时间戳（精确到秒或毫秒均可）；建议在启动时额外输出一行“session start”。
- [x] 日志：每次启动输出明显分割线（避免日志混在一起看不清）
  - 背景：日志文件是 append 模式；如果没有明显分割，很难快速判断“本次启动从哪行开始”。
  - 验收：Agent/MCP/Collector 在启动时输出明显分割线；菜单栏 App 在拉起子进程时也会向对应 log 追加分割信息。
- [x] 非正常退出：子进程需自动退出，避免端口残留（尤其 MCP SSE 4833）
  - 背景：如果菜单栏 App 崩溃/被强制结束，Node 子进程可能继续存活并占用端口，导致下次启动 `EADDRINUSE`。
  - 验收：Agent/MCP/Collector 启动时记录父进程 pid；父进程消失后子进程在 ~1 秒内自动退出释放端口。
- [x] Agent：避免“端口占用仍启动第二实例”（尤其不能破坏 `agent.sock`）
  - 背景：当 `127.0.0.1:4832` 被占用时，第二个 Agent 可能只启动 UDS 并开始压实/写 DB，甚至 unlink 掉正在使用的 `agent.sock`，有数据一致性风险。
  - 验收：Supervisor 启动前先探测 `/health`，端口已存在时不重复拉起；Agent 启动时也会自检并避免在 TCP 失败时启动/覆盖 UDS。
- [x] macOS UI：主窗口应为单例（重复点击“打开主窗口”不应弹出多个）
  - 背景：现在可能出现多个窗口，用户体验差，也会让后续“聊天窗口/搜索窗口”难以管理。
  - 验收：无论点多少次，只会聚焦到同一个主窗口；红灯关闭后再次打开仍保留上次状态（关闭=隐藏）。
- [x] macOS UI：Dock 图标行为符合直觉（可点开/切换/最小化）
  - 背景：当前 SwiftPM 可执行程序的 Dock 交互不符合 macOS 习惯，影响“非开发用户”的使用。
  - 验收：Dock 图标点击可显示主窗口；主窗口可最小化并从 Dock 恢复；从 Dock/红灯关闭窗口不退出菜单栏常驻。
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
- [x] Collector：修复 app/title 与截图/OCR 内容错配（互换）问题
  - 背景：窗口截图失败时会降级到“按窗口 bounds 裁剪屏幕合成画面”，如果前台窗口在采集瞬间发生切换，可能出现 header(app/title) 与 OCR 内容互换。
  - 验收：`logs/collector-ocr.log` 中同一条记录的 `app/title` 与 OCR 内容一致（不再出现“header=Slack 但内容像 Warp”的互换现象）。
  - 备注：已额外过滤 Dock/控制中心等系统 UI 窗口（例如 `app=程序坞`），该类窗口不应进入采集元数据；如日志仍出现，请重启 collector 让新二进制生效。

## 近期计划（Plan：建议的接下来 1~2 个迭代）

> 目标：让它能“放心全天候跑”，同时确保“换电脑/备份”不痛苦。

- [ ] M1-0 稳定性收尾（先把 P0 清干净）
  - 背景：先把“运行稳定+符合直觉”打磨好，后续功能才不会越堆越乱。
  - 验收：P0 列表全部完成，开发期基本不需要手动 kill/重启来救场。
- [ ] M1-4 OCR/压实质量提升（让 chunks 可用）
  - 背景：当前 OCR 原始文本噪声/碎片较多，直接入库会导致检索与总结体验“不可用”。
  - 验收：同一窗口 2 分钟 chunk 内文本显著去重/去噪；搜索结果 snippet 可读；日总结不再被菜单/侧边栏淹没。
  - 子任务（建议优先）：
    - [x] Collector 截图从“全屏”改为“前台窗口区域”（降低 UI 噪声）
      - 背景：全屏截图会把侧边栏/其他窗口/通知等一并 OCR，导致文本非常碎片且不可用。
      - 验收：Notion/浏览器等应用的 OCR 文本明显更聚焦；搜索结果不再被大量无关 UI 文案淹没。
    - [x] Collector：窗口截图失败时，优先改用“窗口 bounds 裁剪”再降级全屏
      - 背景：少数应用窗口无法按 windowID 截图时会退回全屏，噪声依旧很大。
      - 验收：日志中 `capture` 大多数为 `frontmost-window` 或 `window-bounds-crop`；只有极少数场景才出现 `screen-fallback`。
    - [x] Collector：输出 OCR 全文到独立日志（调试用途）
      - 背景：用户难以复制碎片 OCR 来做问题反馈，需要一个“可一键复制”的完整来源。
      - 验收：生成 `${DATA_DIR}/logs/collector-ocr.log`，可在 UI 日志页一键复制；文件超过上限自动轮转为 `.1`。
    - [x] 缩略图默认尺寸提升（更适合多模态输入）
      - 背景：默认 420px 对多模态 LLM 来说偏糊，不利于提取关键信息。
      - 验收：默认提升到 720px；历史库若仍为旧默认值（420）会在迁移时自动更新；用户仍可在设置页手动调整。
    - [x] Agent：压实清洗增强（先让搜索可用）
      - 背景：OCR 会把顶栏/侧边栏/徽标/符号块识别成大量短行，导致 chunk 文本碎片化，搜索结果 snippet 不可读。
      - 验收：新生成的 chunk 不再包含 `File/Edit/View/Window/Help`、`Home/Inbox/Search/99+` 等 UI 短行；`****` 这类符号块不会进入 chunk 文本。
    - [x] 提供“重清洗 chunks”维护接口（仅更新派生文本/索引）
      - 背景：压实清洗规则迭代后，历史 chunks 仍然是旧噪声；只优化新数据不够用。
      - 验收：提供 `POST /v1/maintenance/reclean-chunks`（token 鉴权），可对最近 N 条 chunk 重跑清洗并更新 FTS（如可用）；执行后搜索质量立刻改善。
    - [ ] 压实清洗参数化（可调强度）
      - 背景：不同应用 UI 噪声差异大；过强过滤可能丢信息，过弱则没效果。
      - 验收：至少支持 low/medium/high 三档（或几个关键阈值）；默认适合 Notion/浏览器。
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

## UI（后置清单：主功能稳定后再回来做）

> 说明：当前 UI 以“能控/能用”为主，不追求完整产品体验。等数据管线、迁移、发布形态稳定后再统一做 UI/交互/视觉设计。

- [x] UI-0 日志页：一键复制当前日志 + 打开日志目录
  - 背景：手动拖拽选择日志很难一次性复制；排障时需要快速把日志贴出来。
  - 验收：主窗口「日志」页可一键复制当前显示内容；可一键打开日志目录；支持查看 `collector-ocr.log`。
- [ ] UI-1 主窗口：记住上次 Tab（搜索/日总结/日志/设置）
  - 背景：重启后总回到默认 Tab，会打断使用节奏。
  - 验收：关闭/重启 App 后仍回到上次 Tab；不影响现有“关闭=隐藏”行为。
- [ ] UI-2 搜索体验升级（筛选/排序/高亮）
  - 背景：当前只支持关键词 + limit，难以在长期数据中定位。
  - 验收：支持按时间范围（今天/昨天/本周/自定义）、按 appName 过滤；高亮命中片段；支持“复制引用信息（chunk id + 时间戳）”。
- [ ] UI-3 日总结页：历史列表 + 固定生成策略入口
  - 背景：现在偏“按天拉取”，缺少浏览与回看体验。
  - 验收：可选日期列表；可一键生成/重新生成；能展示引用（来自哪些 chunks）。
- [ ] UI-4 Chat（占位→可用）：只读问答（先基于本地检索，不做写操作）
  - 背景：未来要做聊天，但应先保证“回答必带引用、可追溯”。
  - 验收：支持 `ask`（等 M3 做完）；输出答案 + 引用；可点击跳转到 chunk 详情。
- [ ] UI-5 首次启动引导（权限/数据目录/开机自启）
  - 背景：面向非开发用户需要“开箱即用”的引导流程。
  - 验收：首次运行自动提示屏幕录制/辅助功能权限；展示数据目录与迁移说明；可一键开启“开机自启”（后置）。
- [ ] UI-6 更强的“运行状态页”（健康检查/告警）
  - 背景：长期后台运行必须可观测，避免“挂了但我不知道”。
  - 验收：显示 Agent/MCP/Collector 的健康状态、最近写入时间、错误计数；支持一键导出日志包（debug bundle）。

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
- [ ] 发布形态下的服务托管（不靠命令行）
  - 背景：开发期可以靠 `npm run`，但最终必须对普通用户隐藏。
  - 验收：安装后无需 Node/Swift；菜单栏 App 负责拉起/停止内置 Agent/MCP/Collector；不依赖 shell PATH。
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
  - [x] 稳定性兜底：FTS 不可用时不应导致 Agent 启动失败
    - 背景：数据库里可能已有 `chunks_fts`（例如旧环境创建），但当前 SQLite 运行时缺模块；需要自动降级而不是 fatal。
    - 验收：出现 `no such module: fts5/fts4` 时 Agent 仍能启动，搜索自动走 LIKE，并在日志中给出可操作提示。
  - 方向：评估 `better-sqlite3` / `libsql` 或可控 SQLite 构建方案
  - 验收：10 万 chunks 规模可用延迟（且排序稳定，含 score）
- [ ] 改进 frames→chunks 压实策略（减少重复与噪声）
  - 更稳切分：按 app/window + gap + OCR 文本变化
  - chunk 合并/更新策略（避免碎片化）
- [ ] 采集质量提升（后续：前台窗口截图 / text-first）
  - 背景：全屏截图 + OCR 天然会带入大量无关 UI（菜单/侧栏），并受光标闪烁影响导致重复与错字。
  - 方向：
    - [x] 优先截取前台窗口区域（CGWindowListCreateImage）
    - [ ] 再考虑 AX 可见文本（更像 Littlebird，且更少噪声）
  - 验收：Notion/浏览器等应用的 OCR 噪声显著降低；dHash 去重命中率提升（减少无效 frames）。
- [ ] 观测性：统一日志规范 + 关键指标
  - 背景：长期运行需要“可定位问题”，尤其是采集挂起、磁盘增长、检索变慢等。
  - 验收：关键操作（采集写入/压实/清理/删除/导出）都有结构化日志；能生成一份 debug bundle（日志+版本+配置）。

## 低优先级探索（先记录，暂不做）

- [ ] 图谱/关系层（Graph Memory，不引入独立 GraphDB）
  - 背景：未来希望把“人/项目/文档/链接/任务”等跨应用信息关联起来，支持多跳查询与可解释引用。
  - 约束：本机优先、易打包/易迁移；图数据应为派生数据（可重建），且每条关系必须可追溯到来源 chunk（引用 chunk id）。
  - 方向：
    - 先在 SQLite 中实现轻量图层（entities / edges / mentions / facts），先验证价值
    - 后续再评估是否需要独立 GraphDB（Neo4j/ArangoDB 等）
  - 验收：能回答“我和 X 最近讨论了哪些项目/决策？相关链接在哪？”且每条结论都有来源引用。
