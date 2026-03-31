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
│  │          │  │           │  │  │ingestion│ │  agent    │  │  │
│  │          │  │           │  │  │         │ │(AI 智能体) │  │  │
│  │          │  │           │  │  └─────────┘ └───────────┘  │  │
│  │          │  │           │  │  ┌─────────┐ ┌───────────┐  │  │
│  │          │  │           │  │  │   ai    │ │  search   │  │  │
│  │          │  │           │  │  │(Provider)│ │           │  │  │
│  │          │  │           │  │  └─────────┘ └───────────┘  │  │
│  │          │  │           │  │  ┌─────────┐ ┌───────────┐  │  │
│  │          │  │           │  │  │ storage │ │   api     │  │  │
│  │          │  │           │  │  │         │ │(HTTP + WS)│  │  │
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

| ✅ 可以做 | ❌ 不能做 |
|-----------|----------|
| 调用 Backend API | 直接访问 SurrealDB |
| 渲染截图和文本 | 执行 OCR |
| 管理子进程生命周期 | 直接截屏 |
| 本地 UI 状态管理 | 业务逻辑处理 |
| 展示 AI 回复 | 直接调用 LLM API |
| 用户设置界面 | 直接写配置文件 |

### 对外接口

```
消费：
  ← Engine HTTP API (REST)    获取数据
  ← Engine WebSocket          接收实时通知

生产：
  → 启动/停止 Engine 进程
  → 启动/停止 Collector 进程
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
│   │   │   └── ContextCollector.swift   # 上下文信息聚合
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

| ✅ 可以做 | ❌ 不能做 |
|-----------|----------|
| 截取屏幕 | OCR 文本提取 |
| 帧差异检测 | AI 推理 |
| 截图压缩 (WebP) | 向量化 |
| 写入截图文件 | 写入 SurrealDB |
| 采集窗口标题/应用名 | 实体提取 |
| 隐私过滤 | 搜索查询 |
| 通知 Engine 有新截图 | 直接响应用户查询 |

### 对外接口

```
生产：
  → 截图文件写入 ~/screenshots/
  → HTTP POST → Engine /api/v1/ingest/screenshot
    Body: { path, timestamp, app_name, window_title, display_id }

消费：
  ← Engine API 获取配置（排除列表、截图间隔等）
  ← Engine 健康检查端点
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
  "is_active_window": true,
  "pixel_diff_ratio": 0.35,    // 与上一帧的差异比
  "screen_resolution": "2560x1600"
}
```

---

## Module 3: `engine` (Backend Service)

**语言：** TypeScript + Bun  
**职责边界：** 所有业务逻辑的核心，包含 AI、搜索、存储

Engine 内部进一步分为 **7 个子模块**：

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
│   │   │   ├── settings.ts              # GET/PUT /settings
│   │   │   ├── collector.ts             # POST /collector/control
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
│   │       └── sse.ts                    # SSE 传输 (Web MCP 客户端)
│   │
│   ├── ingestion/                        ← 子模块: Ingestion Pipeline
│   │   ├── pipeline.ts                   # 摄入管线编排
│   │   ├── queue.ts                      # 任务队列（内存队列）
│   │   ├── processors/
│   │   │   ├── ocr.ts                    # OCR 处理器
│   │   │   ├── entityExtractor.ts        # 实体提取 (NER)
│   │   │   ├── embedder.ts               # 向量化处理器
│   │   │   ├── deduplicator.ts           # 去重处理器
│   │   │   └── contextEnricher.ts        # 上下文增强
│   │   └── adapters/
│   │       ├── appleVision.ts            # Apple Vision OCR 适配
│   │       └── tesseract.ts              # Tesseract OCR 适配（降级）
│   │
│   ├── agent/                            ← 子模块: AI Agent (智能体)
│   │   ├── agent.ts                      # Agent 主入口
│   │   ├── intentParser.ts               # 意图理解：LLM 解析用户查询
│   │   ├── taskPlanner.ts                # 任务规划：分解为执行步骤
│   │   ├── executor.ts                   # 执行器：编排工具调用
│   │   ├── synthesizer.ts                # 回答合成：LLM 汇总结果
│   │   ├── tools/                        # Agent 可调用的工具集
│   │   │   ├── tool.ts                   # Tool 抽象接口
│   │   │   ├── vectorSearchTool.ts       # 向量语义搜索
│   │   │   ├── fullTextSearchTool.ts     # 全文精确搜索
│   │   │   ├── graphQueryTool.ts         # 图关系查询
│   │   │   ├── timeFilterTool.ts         # 时间范围过滤
│   │   │   ├── entityLookupTool.ts       # 实体查找
│   │   │   ├── screenshotTool.ts         # 截图详情获取
│   │   │   └── statsTool.ts              # 统计分析
│   │   ├── memory/
│   │   │   ├── conversationMemory.ts     # 对话上下文记忆
│   │   │   └── workingMemory.ts          # 工作记忆（当前任务状态）
│   │   └── prompts/
│   │       ├── intentPrompt.ts           # 意图解析 prompt
│   │       ├── plannerPrompt.ts          # 任务规划 prompt
│   │       └── synthesizerPrompt.ts      # 回答合成 prompt
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
│   │   ├── manager.ts                    # AI 模型管理器
│   │   ├── providers/
│   │   │   ├── provider.ts               # Provider 抽象接口
│   │   │   ├── ollama.ts                 # Ollama 本地 LLM
│   │   │   ├── openai.ts                 # OpenAI API
│   │   │   ├── anthropic.ts              # Anthropic API
│   │   │   └── appleML.ts               # Apple CoreML（未来）
│   │   ├── embedding/
│   │   │   ├── local.ts                  # 本地 Embedding (ONNX)
│   │   │   └── remote.ts                 # 远程 Embedding API
│   │   └── ner/
│   │       ├── extractor.ts              # 命名实体识别
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
│   │   │   └── chatHistoryRepo.ts        # 对话历史仓库
│   │   ├── migrations/
│   │   │   ├── runner.ts                 # 迁移执行器
│   │   │   └── versions/
│   │   │       ├── 001_initial.ts        # 初始表结构
│   │   │       └── ...
│   │   └── schema/
│   │       └── surreal.ts                # SurrealDB Schema 定义
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
               api   mcp   ingestion  agent   search   ai    storage
调用方 ↓     ┌──────┬─────┬──────────┬───────┬────────┬─────┬────────┐
  api        │  -   │  ❌  │    ✅     │  ✅   │   ✅   │  ❌  │   ❌   │
  mcp        │  ❌  │  -   │    ❌     │  ❌   │   ✅   │  ❌  │   ✅   │
  ingestion  │  ❌  │  ❌  │    -      │  ❌   │   ❌   │  ✅  │   ✅   │
  agent      │  ❌  │  ❌  │    ❌     │  -    │   ✅   │  ✅  │   ✅   │
  search     │  ❌  │  ❌  │    ❌     │  ❌   │   -    │  ✅  │   ✅   │
  ai         │  ❌  │  ❌  │    ❌     │  ❌   │   ❌   │  -   │   ❌   │
  storage    │  ❌  │  ❌  │    ❌     │  ❌   │   ❌   │  ❌  │   -    │
             └──────┴─────┴──────────┴───────┴────────┴─────┴────────┘

规则：
  • api 和 mcp 是两个并列的入口层
    - api（HTTP/WS）给内部 Frontend + Collector 使用
    - mcp（stdio/SSE）给外部 AI 系统使用（Claude/Cursor 等）
  • mcp 只暴露原始能力，不调用 agent：
    - 外部 AI 系统自己就是 Agent，自己做意图理解和编排
    - mcp → search（搜索工具）
    - mcp → storage（读取截图/实体/统计，只读）
  • api → agent：内部 Chat 界面的用户查询需要 Agent 编排
  • agent 是内部 AI 智能体，仅服务于 Frontend Chat：
    - agent → search（执行各种搜索）
    - agent → ai（调用 LLM 做意图理解/回答合成）
    - agent → storage（获取截图详情/实体/对话历史）
  • ingestion 可调用 ai（embedding/NER）和 storage（写入数据）
  • ai 是纯模型调用层，不访问 storage
  • storage 是最底层，不调用任何其他模块
```

### Agent 子模块详解

```
Agent 是 Engine 中的 AI 智能体，负责：

1. 接收用户的自然语言查询或对话
2. 理解意图、拆解任务
3. 自主选择并调用工具（搜索、图查询、时间过滤等）
4. 可以多轮工具调用、反思、迭代
5. 最终汇总结果生成自然语言回答

工作流程:
  User "上周我跟张三讨论的链接"
    │
    ▼
  intentParser.ts    → 解析出：时间=上周, 人物=张三, 目标=URL
    │
    ▼
  taskPlanner.ts     → 生成计划：[时间过滤, 实体查找, URL提取, 交叉匹配]
    │
    ▼
  executor.ts        → 依次调用 tools/：
    │                    timeFilterTool → 上周截图 IDs
    │                    entityLookupTool → 张三出现的截图 IDs
    │                    交集 → fullTextSearchTool → 含 URL 的结果
    │
    ▼
  synthesizer.ts     → LLM 汇总结果，生成回答

Agent vs Search 的区别：
  • Search 是底层能力：执行单一搜索策略（向量/全文/图/时间）
  • Agent 是高层编排：理解复杂意图，组合多种搜索，多轮推理

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
  → MCP Server via SSE on port 21891      (给 Web MCP 客户端)

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
│   └── SharedTypes.swift          # Swift 等价类型（手动同步或 codegen）
├── package.json
└── tsconfig.json
```

### 边界规则

| ✅ 可以包含 | ❌ 不能包含 |
|------------|-----------|
| 类型定义 (interface/type) | 业务逻辑 |
| 常量和枚举 | 数据库操作 |
| 纯函数工具 | 网络请求 |
| 校验 schema (Zod) | 状态管理 |
| 错误码定义 | 第三方 SDK 调用 |

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

### Rule 3: 错误隔离

每个模块独立处理错误，不向上层泄露内部实现细节。

```typescript
// ✅ 正确：Storage 层包装错误
class StorageError extends AppError {
  constructor(message: string, cause?: Error) {
    super('STORAGE_ERROR', message, cause);
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
    mode: z.enum(['embedded', 'remote']).default('embedded'),
    path: z.string().default('~/Library/Application Support/RecaplySense/db'),
    remoteUrl: z.string().optional(),
  }),
  ai: z.object({
    embeddingModel: z.string().default('bge-small-en-v1.5'),
    llmProvider: z.enum(['ollama', 'openai', 'anthropic']).default('ollama'),
    ollamaUrl: z.string().default('http://localhost:11434'),
  }),
  capture: z.object({
    intervalMs: z.number().default(2000),
    minDiffRatio: z.number().default(0.05),
    excludedApps: z.array(z.string()).default([]),
  }),
});
```
