# Recaply Sense — Module Boundaries

> Version: 0.1.0 | Last Updated: 2026-03-31

## Module Map

系统分为 **5 个顶层模块**，每个模块有明确的职责边界和通信接口。

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  ┌──────────┐  ┌───────────┐  ┌─────────────────────────────┐  │
│  │ frontend │  │ collector │  │          engine              │  │
│  │ (SwiftUI)│  │  (Swift)  │  │       (TypeScript)           │  │
│  │          │  │           │  │                              │  │
│  │          │  │           │  │  ┌─────────┐ ┌───────────┐  │  │
│  │          │  │           │  │  │   api   │ │   mcp     │  │  │
│  │          │  │           │  │  │(HTTP+WS)│ │(MCP入口)   │  │  │
│  │          │  │           │  │  └─────────┘ └───────────┘  │  │
│  │          │  │           │  │  ┌─────────┐ ┌───────────┐  │  │
│  │          │  │           │  │  │ingestion│ │  agent    │  │  │
│  │          │  │           │  │  │         │ │(AI 智能体) │  │  │
│  │          │  │           │  │  └─────────┘ └───────────┘  │  │
│  │          │  │           │  │  ┌─────────┐ ┌───────────┐  │  │
│  │          │  │           │  │  │ vision  │ │  search   │  │  │
│  │          │  │           │  │  │(活动摘要)│ │           │  │  │
│  │          │  │           │  │  └─────────┘ └───────────┘  │  │
│  │          │  │           │  │  ┌─────────┐ ┌───────────┐  │  │
│  │          │  │           │  │  │   ai    │ │  storage  │  │  │
│  │          │  │           │  │  │(Provider)│ │           │  │  │
│  │          │  │           │  │  └─────────┘ └───────────┘  │  │
│  └──────────┘  └───────────┘  └─────────────────────────────┘  │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                      shared                                ││
│  │              (types, constants, utils)                      ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

---

## Module 1: `frontend` (macOS SwiftUI App)

**语言：** Swift  
**职责边界：** 纯 UI 展示与用户交互，不包含业务逻辑

```
frontend/
├── RecaplySense/
│   ├── App/
│   │   ├── RecaplySenseApp.swift        # App 入口，生命周期管理
│   │   ├── AppDelegate.swift            # NSApplicationDelegate
│   │   └── ProcessManager.swift         # 管理 collector/engine 子进程
│   ├── Views/
│   │   ├── MenuBar/
│   │   │   ├── MenuBarView.swift        # 菜单栏常驻图标
│   │   │   └── QuickSearchView.swift    # 快捷搜索弹窗
│   │   ├── Timeline/
│   │   │   ├── TimelineView.swift       # 时间线主视图
│   │   │   ├── ScreenshotCard.swift     # 截图卡片组件
│   │   │   └── TimelineFilter.swift     # 时间/应用/人物过滤
│   │   ├── Search/
│   │   │   ├── SearchView.swift         # 搜索主视图
│   │   │   └── SearchResultView.swift   # 搜索结果展示
│   │   ├── Chat/
│   │   │   ├── ChatView.swift           # AI 对话界面
│   │   │   └── MessageBubble.swift      # 消息气泡组件
│   │   ├── Settings/
│   │   │   ├── SettingsView.swift       # 设置主视图
│   │   │   ├── PrivacySettings.swift    # 隐私控制
│   │   │   ├── StorageSettings.swift    # 存储管理
│   │   │   └── AISettings.swift         # AI 模型设置
│   │   └── Onboarding/
│   │       └── OnboardingView.swift     # 首次使用引导
│   ├── Services/
│   │   ├── APIClient.swift              # HTTP REST 客户端
│   │   ├── WebSocketClient.swift        # WS 实时连接
│   │   └── KeyboardShortcut.swift       # 全局快捷键
│   ├── Models/
│   │   └── ViewModels.swift             # UI 层数据模型
│   └── Resources/
│       └── Assets.xcassets
├── RecaplySense.xcodeproj
└── Package.swift
```

### 边界规则

| ✅ 可以做                      | ❌ 不能做          |
| ------------------------------ | ------------------ |
| 调用 Backend API               | 直接访问 SurrealDB |
| 渲染截图和文本                 | 执行 OCR           |
| 注册 LaunchAgent (首次安装时)  | 直接截屏           |
| 本地 UI 状态管理               | 业务逻辑处理       |
| 展示 AI 回复                   | 直接调用 LLM API   |
| 用户设置界面                   | 直接写配置文件     |

### 对外接口

```
消费：
  ← Engine HTTP API (REST)    获取数据
  ← Engine WebSocket          接收实时通知

生产：
  → 首次安装时注册 Engine + Collector 为 LaunchAgent (SMAppService)
  → 设置页面提供"停止后台服务"选项（注销 LaunchAgent）
```

---

## Module 2: `collector` (Screen Capture Daemon)

**语言：** Swift  
**职责边界：** 屏幕数据采集，不包含 AI 处理逻辑

```
collector/
├── Sources/
│   ├── RecaplyCollector/
│   │   ├── main.swift                   # Daemon 入口
│   │   ├── CaptureEngine/
│   │   │   ├── ScreenRecorder.swift     # ScreenCaptureKit 封装
│   │   │   ├── ChangeDetector.swift     # 帧差异检测算法
│   │   │   ├── CaptureScheduler.swift   # 截图调度（2s 间隔）
│   │   │   └── DisplayManager.swift     # 多显示器管理
│   │   ├── Privacy/
│   │   │   ├── PrivacyFilter.swift      # 隐私过滤器
│   │   │   ├── AppExcluder.swift        # 应用排除列表
│   │   │   └── ContentDetector.swift    # 敏感内容检测
│   │   ├── Storage/
│   │   │   ├── ScreenshotWriter.swift   # WebP 压缩写入
│   │   │   ├── FileNaming.swift         # 文件命名规则
│   │   │   └── StorageManager.swift     # 磁盘空间管理
│   │   ├── Context/
│   │   │   ├── ActiveAppDetector.swift  # 当前活跃应用检测
│   │   │   ├── WindowTitleReader.swift  # 窗口标题读取
│   │   │   ├── TimezoneCapture.swift   # 采集时的 IANA 时区
│   │   │   └── ContextCollector.swift   # 上下文信息聚合
│   │   ├── OCR/                         # OCR 模块 (TDR-017)
│   │   │   ├── VisionOCR.swift          # Apple Vision 文字识别
│   │   │   └── OCRProcessor.swift       # OCR 编排（截图→文字）
│   │   ├── Network/
│   │   │   ├── EngineClient.swift       # 与 Engine 通信
│   │   │   └── HealthCheck.swift        # Engine 健康检测
│   │   └── Config/
│   │       └── CollectorConfig.swift    # 采集器配置
│   └── RecaplyCollectorTests/
│       └── ...
└── Package.swift
```

### 边界规则

| ✅ 可以做            | ❌ 不能做        |
| -------------------- | ---------------- |
| 截取屏幕             | AI 推理          |
| 帧差异检测           | 向量化           |
| 截图压缩 (WebP)      | 写入 SurrealDB   |
| OCR 文本提取 (Apple Vision) | 实体提取   |
| 写入截图文件         | 搜索查询         |
| 采集窗口标题/应用名  | 直接响应用户查询 |
| 隐私过滤             |                  |
| 通知 Engine 有新截图 |                  |

### 对外接口

```
生产：
  → 截图文件写入 ~/screenshots/
  → HTTP POST → Engine /api/v1/ingest/screenshot
    Body: { path, timestamp, app_name, window_title, display_id,
            ocr_text, capture_id, timezone, ... }

消费：
  ← Engine GET /api/v1/collector/config（轮询配置 + 控制指令，每 5 秒）
  ← Engine GET /api/v1/health（健康检查）

生产（心跳）：
  → Engine POST /api/v1/collector/heartbeat
    Body: { status, uptime_seconds, screenshots_today, last_capture_at }
```

### Collector → Engine 通信协议

```typescript
// Collector 每次截图后发送给 Engine
POST /api/v1/ingest/screenshot
{
  "path": "/Users/xxx/Library/.../screenshots/2026/03/31/143012_abc123.webp",
  "timestamp": "2026-03-31T14:30:12.000Z",
  "app_name": "Slack",
  "window_title": "#general - Slack",
  "bundle_id": "com.tinyspeck.slackmacgap",
  "display_id": 1,
  "is_active": true,
  "diff_ratio": 0.35,              // 与上一帧的差异比
  "resolution": "2560x1600",
  "file_size": 204800,             // 文件大小 (bytes)
  "ocr_text": "张三: 看一下这个链接...", // Apple Vision OCR 提取的文本 (TDR-017)
  "capture_id": "a1b2c3d4e5f6...", // 幂等 ID: sha256(path + timestamp + file_size + machine_id)
  "timezone": "Asia/Shanghai"       // 采集时的时区
}
```

---

## Module 3: `engine` (Backend Service)

**语言：** TypeScript + Bun  
**职责边界：** 所有业务逻辑的核心，包含 AI、搜索、存储

Engine 内部进一步分为 **10 个子模块**：

```
engine/
├── src/
│   ├── index.ts                          # Bun 服务入口
│   ├── config/
│   │   ├── index.ts                      # 配置加载
│   │   └── schema.ts                     # 配置校验 (Zod)
│   │
│   ├── api/                              ← 子模块: API Layer (内部 UI 用)
│   │   ├── router.ts                     # 路由总入口
│   │   ├── middleware/
│   │   │   ├── auth.ts                   # 本地认证（可选）
│   │   │   ├── rateLimit.ts              # 请求限流
│   │   │   └── errorHandler.ts           # 统一错误处理
│   │   ├── routes/
│   │   │   ├── ingest.ts                 # POST /ingest/*
│   │   │   ├── search.ts                 # POST /search
│   │   │   ├── timeline.ts              # GET /timeline
│   │   │   ├── chat.ts                   # POST /chat, WS /chat/stream
│   │   │   ├── entities.ts              # GET /entities/*
│   │   │   ├── screenshots.ts           # GET /screenshots/*
│   │   │   ├── settings.ts              # GET/PATCH /settings
│   │   │   ├── collector.ts             # POST /collector/control
│   │   │   ├── stats.ts                 # GET /stats/*
│   │   │   └── health.ts                # GET /health
│   │   └── ws/
│   │       ├── handler.ts                # WebSocket 连接管理
│   │       └── events.ts                 # WS 事件定义
│   │
│   ├── mcp/                              ← 子模块: MCP Server (外部 AI 系统接入)
│   │   ├── server.ts                     # MCP Server 入口
│   │   ├── tools/                        # MCP Tools (暴露原始能力，不含 Agent)
│   │   │   ├── searchMemory.ts           # search_memory: 向量/全文/混合搜索
│   │   │   ├── browseTimeline.ts         # browse_timeline: 按时间浏览截图
│   │   │   ├── lookupEntity.ts           # lookup_entity: 查找实体详情
│   │   │   ├── getEntityGraph.ts         # get_entity_graph: 实体关系图
│   │   │   ├── getScreenshotDetail.ts    # get_screenshot_detail: 截图+OCR
│   │   │   └── getActivitySummary.ts     # get_activity_summary: 活动统计
│   │   ├── resources/                    # MCP Resources (可读取的上下文)
│   │   │   ├── todaySummary.ts           # recaply://today/summary
│   │   │   ├── recentScreenshots.ts      # recaply://recent/screenshots
│   │   │   ├── frequentEntities.ts       # recaply://entities/frequent
│   │   │   └── statsOverview.ts          # recaply://stats/overview
│   │   └── transport/
│   │       ├── stdio.ts                  # stdio 传输 (Claude Desktop/Cursor)
│   │       └── streamableHttp.ts         # Streamable HTTP 传输 (Web MCP 客户端)
│   │
│   ├── ingestion/                        ← 子模块: Ingestion Pipeline
│   │   ├── pipeline.ts                   # 摄入管线编排
│   │   ├── queue.ts                      # 任务队列（启动时扫描 status='queued'|'processing' 恢复）
│   │   ├── processors/
│   │   │   ├── chineseTokenizer.ts       # 中文分词（jieba-wasm）
│   │   │   ├── entityExtractor.ts        # 实体提取 (NER)
│   │   │   ├── embedder.ts               # 向量化处理器 (BGE-M3)
│   │   │   ├── deduplicator.ts           # 去重（capture_id 幂等）
│   │   │   └── contextEnricher.ts        # 上下文增强
│   │   └── adapters/
│   │       └── tesseract.ts              # Tesseract OCR 适配（纯TS降级方案）
│   │
│   ├── vision/                           ← 子模块: Vision LLM 处理 (TDR-019)
│   │   ├── sessionManager.ts            # App Session 管理（开始/结束/flush）
│   │   ├── frameSelector.ts             # OCR 文本去重 + 代表帧选择（≤8帧）
│   │   ├── visionAnalyzer.ts            # Vision LLM 调用 + 结构化输出
│   │   └── segmentWriter.ts             # activity_segment 写入存储
│   │
│   ├── agent/                            ← 子模块: AI Agent (智能体)
│   │   ├── agent.ts                      # Agent 主入口（AI SDK streamText + tools）
│   │   ├── tools/                        # Agent 可调用的工具集（AI SDK tool 格式）
│   │   │   ├── vectorSearchTool.ts       # 向量语义搜索
│   │   │   ├── fullTextSearchTool.ts     # 全文精确搜索
│   │   │   ├── graphQueryTool.ts         # 图关系查询
│   │   │   ├── timeFilterTool.ts         # 时间范围过滤
│   │   │   ├── entityLookupTool.ts       # 实体查找
│   │   │   ├── screenshotTool.ts         # 截图详情获取
│   │   │   ├── activitySearchTool.ts    # 活动片段搜索 (activity_segment)
│   │   │   └── statsTool.ts              # 统计分析
│   │   ├── memory/
│   │   │   ├── conversationMemory.ts     # 对话上下文记忆
│   │   │   └── workingMemory.ts          # 工作记忆（当前任务状态）
│   │   └── prompts/
│   │       └── systemPrompt.ts           # Agent 系统 prompt
│   │
│   ├── search/                           ← 子模块: Search Engine
│   │   ├── engine.ts                     # 搜索引擎主入口
│   │   ├── strategies/
│   │   │   ├── vectorSearch.ts           # 向量语义搜索
│   │   │   ├── fullTextSearch.ts         # 全文精确搜索
│   │   │   ├── graphSearch.ts            # 图关系搜索
│   │   │   ├── timeRangeSearch.ts        # 时间范围搜索
│   │   │   └── hybridSearch.ts           # 混合搜索融合
│   │   └── ranker.ts                     # 结果排序器
│   │
│   ├── ai/                               ← 子模块: AI Provider (纯模型调用层)
│   │   ├── providers.ts                  # AI SDK provider 工厂（按配置返回 openai/anthropic/ollama）
│   │   ├── embedding/
│   │   │   ├── local.ts                  # 本地 Embedding (BGE-M3 ONNX)
│   │   │   └── remote.ts                 # 远程 Embedding API (BGE-M3 云端)
│   │   └── ner/
│   │       ├── extractor.ts              # 命名实体识别（AI SDK generateObject）
│   │       └── patterns.ts               # 实体模式定义
│   │
│   ├── storage/                          ← 子模块: Storage Layer
│   │   ├── database.ts                   # SurrealDB 连接管理
│   │   ├── repositories/
│   │   │   ├── screenshotRepo.ts         # 截图数据仓库
│   │   │   ├── entityRepo.ts             # 实体数据仓库
│   │   │   ├── relationshipRepo.ts       # 关系数据仓库
│   │   │   ├── embeddingRepo.ts          # 向量数据仓库
│   │   │   ├── settingsRepo.ts           # 设置数据仓库
│   │   │   ├── activitySegmentRepo.ts    # 活动片段仓库
│   │   │   └── chatHistoryRepo.ts        # 对话历史仓库
│   │   ├── migrations/
│   │   │   ├── runner.ts                 # 迁移执行器
│   │   │   └── versions/
│   │   │       ├── 001_initial.ts        # 初始表结构
│   │   │       └── ...
│   │   └── schema/
│   │       └── surreal.ts                # SurrealDB Schema 定义
│   │
│   ├── scheduler/                        ← 子模块: 定时任务调度
│   │   ├── registry.ts                   # 任务注册表
│   │   └── tasks/
│   │       ├── screenshotCleanup.ts      # 截图清理（按保留策略 + 磁盘阈值）
│   │       ├── backupDaily.ts            # 每日自动备份
│   │       ├── deadLetterScan.ts         # Dead letter 扫描与重试
│   │       └── visionRetry.ts            # Vision LLM 失败帧重试
│   │
│   ├── events/                           ← 公共基础设施: 进程内事件总线
│   │   ├── bus.ts                        # 进程内事件总线（typed EventEmitter）
│   │   └── types.ts                      # 事件类型定义
│   │
│   └── utils/
│       ├── logger.ts                     # 日志工具
│       ├── errors.ts                     # 错误类型定义
│       └── timing.ts                     # 性能计时器
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
├── package.json
├── tsconfig.json
└── bunfig.toml
```

### 子模块边界矩阵

```
               可以调用 →
               api   mcp   ingestion  vision  agent  search  ai    storage  events  scheduler
调用方 ↓     ┌──────┬─────┬──────────┬───────┬──────┬───────┬─────┬────────┬───────┬──────────┐
  api        │  -   │  ❌  │    ✅     │  ❌   │  ✅  │  ✅   │  ❌ │   ❌   │  ✅   │    ✅    │
  mcp        │  ❌  │  -   │    ❌     │  ❌   │  ❌  │  ✅   │  ❌ │   ✅   │  ✅   │    ❌    │
  ingestion  │  ❌  │  ❌  │    -      │  ✅   │  ❌  │  ❌   │  ✅ │   ✅   │  ✅   │    ❌    │
  vision     │  ❌  │  ❌  │    ❌     │  -    │  ❌  │  ❌   │  ✅ │   ✅   │  ✅   │    ❌    │
  agent      │  ❌  │  ❌  │    ❌     │  ❌   │  -   │  ✅   │  ✅ │   ✅   │  ✅   │    ❌    │
  search     │  ❌  │  ❌  │    ❌     │  ❌   │  ❌  │  -    │  ✅ │   ✅   │  ✅   │    ❌    │
  ai         │  ❌  │  ❌  │    ❌     │  ❌   │  ❌  │  ❌   │  -  │   ❌   │  ✅   │    ❌    │
  storage    │  ❌  │  ❌  │    ❌     │  ❌   │  ❌  │  ❌   │  ❌ │   -    │  ✅   │    ❌    │
  events     │  ❌  │  ❌  │    ❌     │  ❌   │  ❌  │  ❌   │  ❌ │   ❌   │  -    │    ❌    │
  scheduler  │  ❌  │  ❌  │    ✅     │  ✅   │  ❌  │  ❌   │  ❌ │   ✅   │  ✅   │    -     │
             └──────┴─────┴──────────┴───────┴──────┴───────┴─────┴────────┴───────┴──────────┘

规则：
  • api 和 mcp 是两个并列的入口层
    - api（HTTP/WS）给内部 Frontend + Collector 使用
    - mcp（stdio/Streamable HTTP）给外部 AI 系统使用（Claude/Cursor 等）
  • mcp 只暴露原始能力，不调用 agent：
    - 外部 AI 系统自己就是 Agent，自己做意图理解和编排
    - mcp → search（搜索工具）
    - mcp → storage（读取截图/实体/统计，只读）
  • api → agent：内部 Chat 界面的用户查询需要 Agent 编排
  • agent 是内部 AI 智能体，仅服务于 Frontend Chat：
    - agent → search（执行各种搜索）
    - agent → ai（调用 LLM 做意图理解/回答合成）
    - agent → storage（获取截图详情/实体/对话历史/活动片段）
  • ingestion 可调用 ai（embedding/NER）和 storage（写入数据）
    - OCR 由 Collector 端完成（TDR-017），Engine 接收 ocr_text
    - ingestion 对中文 OCR 文本做分词后存入检索字段
    - ingestion → vision：截图入库后通知 vision 模块更新 App Session
  • vision 是 App Session 级别的理解层（TDR-019）：
    - vision → ai（调用 Vision LLM）
    - vision → storage（读取截图帧、写入 activity_segment）
    - 由 ingestion 触发，异步处理，不阻塞摄入管线
  • ai 是纯模型调用层，不访问 storage
  • storage 是最底层，不调用任何其他模块
  • events 是进程内事件总线（typed EventEmitter），所有模块均可 emit/subscribe，解决业务层向入口层通信的反向依赖问题
  • scheduler 承载所有跨模块的周期性运维任务：
    - scheduler → storage（截图清理、备份）
    - scheduler → ingestion（dead letter 重试）
    - scheduler → vision（失败帧重试）
    - api → scheduler（手动触发备份/清理）
    - scheduler 通过 EventBus 发送执行结果通知
```

### Agent 子模块详解

```
Agent 是 Engine 中的 AI 智能体，基于 Vercel AI SDK 构建（TDR-016），负责：

1. 接收用户的自然语言查询或对话
2. 通过 AI SDK 的 tool calling 自主选择并调用工具
3. 工具包括搜索、图查询、时间过滤、实体查找等
4. 可以多轮工具调用、反思、迭代（AI SDK 自动编排）
5. 最终汇总结果生成自然语言回答

工作流程（AI SDK streamText + tools）:
  User "上周我跟张三讨论的链接"
    │
    ▼
  agent.ts (AI SDK streamText)
    │  LLM 自行规划工具调用序列
    ▼
  Tool calls (自动编排):
    │  timeFilterTool → 上周截图 IDs
    │  entityLookupTool → 张三出现的截图 IDs
    │  交集 → fullTextSearchTool → 含 URL 的结果
    │
    ▼
  LLM 汇总结果，流式返回自然语言回答

Agent vs Search 的职责边界：
  • Search 是确定性底层能力：接受显式策略和过滤条件，执行搜索
    - 不做意图理解，不做查询规划
    - /search API 只接受 strategy: vector|fulltext|graph|hybrid + 显式 filters
  • Agent 是智能编排层：理解自然语言意图，组合多种搜索，多轮推理
    - 自然语言查询只走 /chat（由 Agent 编排后调用 Search）

  Search: "SELECT * FROM screenshot WHERE ocr_text @@ 'github'"
  Agent:  "帮我找上周张三在 Slack 上发的那个 GitHub 链接"
          → 需要理解时间+人物+应用+URL类型，组合4次搜索
```

### Engine 对外接口

```
提供：
  → HTTP REST API on port 21890           (给 Frontend / Collector)
  → WebSocket on port 21890/ws            (给 Frontend 实时通知)
  → MCP Server via stdio                  (给 Claude Desktop / Cursor)
  → MCP Server via Streamable HTTP on port 21891 (给 Web MCP 客户端)

消费：
  ← Collector HTTP POST（接收截图通知）
  ← SurrealDB（embedded 或 localhost:8000）
  ← Ollama API（本地 LLM，localhost:11434）
  ← OpenAI / Anthropic API（云端 LLM，可选）
```

---

## Module 4: `shared` (Shared Types & Utilities)

**语言：** TypeScript (被 engine 消费) + Swift 等价定义  
**职责边界：** 跨模块共享的类型定义、常量和工具函数

```
shared/
├── src/
│   ├── types/
│   │   ├── screenshot.ts          # 截图相关类型
│   │   ├── entity.ts              # 实体类型（人/应用/URL/话题）
│   │   ├── relationship.ts        # 关系类型（related_to 等）
│   │   ├── activity.ts            # 活动片段类型 (TDR-019)
│   │   ├── search.ts              # 搜索请求/响应类型
│   │   ├── chat.ts                # 对话消息类型
│   │   ├── timeline.ts            # 时间线类型
│   │   ├── settings.ts            # 设置类型
│   │   └── events.ts              # WebSocket 事件类型
│   ├── constants/
│   │   ├── api.ts                 # API 路径常量
│   │   ├── defaults.ts            # 默认配置值
│   │   └── limits.ts              # 系统限制常量
│   └── utils/
│       ├── date.ts                # 日期工具
│       └── validation.ts          # 通用校验
├── swift/
│   └── SharedTypes.swift          # Swift Codable 类型（由 quicktype 自动生成，勿手动编辑）
├── package.json
└── tsconfig.json
```

### 边界规则

| ✅ 可以包含               | ❌ 不能包含     |
| ------------------------- | --------------- |
| 类型定义 (interface/type) | 业务逻辑        |
| 常量和枚举                | 数据库操作      |
| 纯函数工具                | 网络请求        |
| 校验 schema (Zod)         | 状态管理        |
| 错误码定义                | 第三方 SDK 调用 |

---

## Module 5: `scripts` (Build & Development Tools)

```
scripts/
├── build.sh                # 完整构建脚本
├── dev.sh                  # 开发环境启动
├── package-app.sh          # 打包为 .app
├── create-dmg.sh           # 创建 DMG 安装包
└── setup-models.sh         # 下载本地 AI 模型
```

---

## Cross-Module Communication Rules

### Rule 0: Collector 控制链路

```
Frontend 控制 Collector 的流程：

  Frontend ──POST /collector/control──▶ Engine
  Engine   ──写入 settings 表──▶ SurrealDB
  Collector ──GET /collector/config 轮询──▶ Engine

实现方式：
  1. Engine 收到 collector:pause/resume/stop 后，将指令写入 settings 表
     key: "collector_control", value: { action: "pause", at: "2026-03-31T..." }
  2. Collector 每 5 秒轮询 GET /api/v1/collector/config 获取：
     - 控制指令（pause/resume/stop）
     - 排除列表更新
     - 截图间隔/质量参数
  3. Collector 执行指令后回报状态：
     POST /api/v1/collector/heartbeat { status: "paused", ... }
  4. Engine 通过 WS 推送 collector:status 给 Frontend

为什么是轮询而非长连接？
  • Collector 是轻量 CLI Daemon，保持 WS 长连接增加复杂度
  • 5 秒轮询延迟对控制指令完全可接受（用户感知 < 5s）
  • 轮询同时兼作心跳，Engine 超过 15s 无轮询 → 标记 Collector 异常
  • 符合 Rule 1 单向依赖：Collector 主动拉取，Engine 不反向调用
```

---

### Rule 1: 单向依赖

```
frontend  ──▶ engine (via HTTP/WS)
collector ──▶ engine (via HTTP)
engine    ──▶ SurrealDB (embedded)
engine    ──▶ Ollama (HTTP)
engine    ──▶ Cloud LLM APIs (HTTP)

❌ 禁止反向依赖：
engine ──✗──▶ frontend
engine ──✗──▶ collector
（Engine 通过 WebSocket 推送通知，但不主动调用 frontend/collector）
```

### Rule 2: 接口优先

所有模块间通信必须通过**明确定义的接口**，不允许直接访问内部实现。

```typescript
// ✅ 正确：通过 Repository 接口访问数据
interface ScreenshotRepository {
  save(screenshot: Screenshot): Promise<void>;
  findByTimeRange(start: Date, end: Date): Promise<Screenshot[]>;
  findByApp(appName: string): Promise<Screenshot[]>;
}

// ❌ 错误：直接写 SurrealDB 查询
await db.query("SELECT * FROM screenshot WHERE ...");
```

### Rule 6: 跨 Repository 事务

多个 Repository 的写操作需要原子性时，使用 `withTransaction` 辅助函数。

```typescript
// ✅ 正确：Ingestion Pipeline 的原子写入
async function processScreenshot(data: IngestData) {
  await withTransaction(db, async (tx) => {
    await screenshotRepo.save(tx, screenshot);
    await entityRepo.upsert(tx, entities);
    await relationshipRepo.createEdges(tx, edges);
  });
  // 事务提交后再做 Embedding（允许单独失败和重试）
  await embeddingRepo.saveEmbedding(screenshot.id, vector);
}

// ❌ 错误：各 Repository 独立写入，中间失败导致数据不一致
await screenshotRepo.save(screenshot);
await entityRepo.upsert(entities);     // 这里失败 → screenshot 成为孤立记录
await relationshipRepo.createEdges(edges);
```

规则：
  - 结构化数据（screenshot + entity + 关系边）的写入必须包裹在事务中
  - Embedding 写入可在事务外执行（允许独立重试，失败不影响结构化数据完整性）
  - Repository 方法签名需支持可选的事务上下文参数

### Rule 3: 错误隔离

每个模块独立处理错误，不向上层泄露内部实现细节。

```typescript
// ✅ 正确：Storage 层包装错误
class StorageError extends AppError {
  constructor(message: string, cause?: Error) {
    super("STORAGE_ERROR", message, cause);
  }
}

// ❌ 错误：让 SurrealDB 的原始错误直接传到 API 层
```

### Rule 4: 配置外部化

每个模块的配置通过环境变量或配置文件注入，不硬编码。

```typescript
// engine/src/config/schema.ts
export const engineConfig = z.object({
  port: z.number().default(21890),
  db: z.object({
    mode: z.enum(["embedded", "remote"]).default("embedded"),
    path: z.string().default("~/Library/Application Support/RecaplySense/db"),
    remoteUrl: z.string().optional(),
  }),
  ai: z.object({
    embeddingModel: z.string().default("bge-m3"),
    embeddingDimensions: z.number().default(1024),
    embeddingEndpoint: z.string().optional(), // 云端 BGE-M3 API 端点
    llmProvider: z.enum(["ollama", "openai", "anthropic"]), // 无默认值，首次启动引导用户选择
    ollamaUrl: z.string().default("http://localhost:11434"),
  }),
  capture: z.object({
    intervalMs: z.number().default(2000),
    minDiffRatio: z.number().default(0.05),
    excludedApps: z.array(z.string()).default([]),
  }),
});
```

### Rule 5: 事件驱动解耦（EventBus）

业务模块不能直接调用入口层（api/mcp），所有需要"通知外部"的场景通过事件总线解耦。

```typescript
// ✅ 正确：业务模块通过 EventBus emit 事件
// ingestion/pipeline.ts
eventBus.emit('ingestion:progress', { screenshot_id, stage, progress });

// api/ws/handler.ts 订阅事件并推送给客户端
eventBus.on('ingestion:progress', (data) => ws.send(data));

// ❌ 错误：业务模块直接 import api 层的推送函数
import { pushToWebSocket } from '../api/ws/handler';
```

同时用于 ingestion → vision 的触发：
```typescript
// ingestion/pipeline.ts
eventBus.emit('screenshot:ingested', { screenshot_id, bundle_id });

// vision/sessionManager.ts
eventBus.on('screenshot:ingested', (data) => sessionManager.onNewScreenshot(data));
```
