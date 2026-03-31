# Recaply Sense — Directory Structure & Monorepo Setup

> Version: 0.1.0 | Last Updated: 2026-03-31

## Monorepo Root Structure

```
recaply-sense/
│
├── README.md                          # 项目总览
├── LICENSE
├── .gitignore
├── .editorconfig
├── turbo.json                         # Turborepo 配置
├── package.json                       # Root workspace 配置
├── bun.lockb                          # Bun lockfile
│
├── docs/                              # 📚 项目文档
│   ├── architecture/                  # 架构设计文档
│   │   ├── system-overview.md
│   │   ├── module-boundaries.md
│   │   ├── data-models.md
│   │   ├── api-contracts.md
│   │   └── tech-decisions.md
│   ├── guides/                        # 开发指南
│   │   ├── getting-started.md
│   │   ├── development.md
│   │   └── deployment.md
│   └── api/
│       └── CHANGELOG.md              # API 变更日志
│
├── apps/                              # 🚀 可部署的应用
│   │
│   ├── desktop/                       # macOS Desktop App (SwiftUI)
│   │   ├── RecaplySense/
│   │   │   ├── App/
│   │   │   │   ├── RecaplySenseApp.swift
│   │   │   │   ├── AppDelegate.swift
│   │   │   │   └── ProcessManager.swift
│   │   │   ├── Views/
│   │   │   │   ├── MenuBar/
│   │   │   │   │   ├── MenuBarView.swift
│   │   │   │   │   └── QuickSearchView.swift
│   │   │   │   ├── Timeline/
│   │   │   │   │   ├── TimelineView.swift
│   │   │   │   │   ├── ScreenshotCard.swift
│   │   │   │   │   └── TimelineFilter.swift
│   │   │   │   ├── Search/
│   │   │   │   │   ├── SearchView.swift
│   │   │   │   │   └── SearchResultView.swift
│   │   │   │   ├── Chat/
│   │   │   │   │   ├── ChatView.swift
│   │   │   │   │   └── MessageBubble.swift
│   │   │   │   ├── Settings/
│   │   │   │   │   ├── SettingsView.swift
│   │   │   │   │   ├── PrivacySettings.swift
│   │   │   │   │   ├── StorageSettings.swift
│   │   │   │   │   └── AISettings.swift
│   │   │   │   └── Onboarding/
│   │   │   │       └── OnboardingView.swift
│   │   │   ├── Services/
│   │   │   │   ├── APIClient.swift
│   │   │   │   ├── WebSocketClient.swift
│   │   │   │   └── KeyboardShortcut.swift
│   │   │   ├── Models/
│   │   │   │   └── ViewModels.swift
│   │   │   └── Resources/
│   │   │       └── Assets.xcassets
│   │   ├── RecaplySense.xcodeproj
│   │   └── Package.swift
│   │
│   └── collector/                      # Screen Capture Collector (Swift CLI)
│       ├── Sources/
│       │   └── RecaplyCollector/
│       │       ├── main.swift
│       │       ├── CaptureEngine/
│       │       │   ├── ScreenRecorder.swift
│       │       │   ├── ChangeDetector.swift
│       │       │   ├── CaptureScheduler.swift
│       │       │   └── DisplayManager.swift
│       │       ├── Privacy/
│       │       │   ├── PrivacyFilter.swift
│       │       │   ├── AppExcluder.swift
│       │       │   └── ContentDetector.swift
│       │       ├── Storage/
│       │       │   ├── ScreenshotWriter.swift
│       │       │   ├── FileNaming.swift
│       │       │   └── StorageManager.swift
│       │       ├── Context/
│       │       │   ├── ActiveAppDetector.swift
│       │       │   ├── WindowTitleReader.swift
│       │       │   ├── TimezoneCapture.swift    # 采集时的 IANA 时区
│       │       │   └── ContextCollector.swift
│       │       ├── OCR/                         # OCR 模块 (TDR-017)
│       │       │   ├── VisionOCR.swift          # Apple Vision 文字识别
│       │       │   └── OCRProcessor.swift       # OCR 编排（截图→文字）
│       │       ├── Network/
│       │       │   ├── EngineClient.swift
│       │       │   └── HealthCheck.swift
│       │       └── Config/
│       │           └── CollectorConfig.swift
│       ├── Tests/
│       │   └── RecaplyCollectorTests/
│       └── Package.swift
│
├── packages/                          # 📦 共享包
│   │
│   ├── engine/                        # Backend Engine (TypeScript + Bun)
│   │   ├── src/
│   │   │   ├── index.ts              # 服务入口
│   │   │   ├── config/
│   │   │   │   ├── index.ts
│   │   │   │   └── schema.ts
│   │   │   ├── api/
│   │   │   │   ├── router.ts
│   │   │   │   ├── middleware/
│   │   │   │   │   ├── auth.ts
│   │   │   │   │   ├── rateLimit.ts
│   │   │   │   │   └── errorHandler.ts
│   │   │   │   ├── routes/
│   │   │   │   │   ├── ingest.ts
│   │   │   │   │   ├── search.ts
│   │   │   │   │   ├── timeline.ts
│   │   │   │   │   ├── chat.ts
│   │   │   │   │   ├── entities.ts
│   │   │   │   │   ├── screenshots.ts
│   │   │   │   │   ├── settings.ts
│   │   │   │   │   ├── collector.ts
│   │   │   │   │   ├── stats.ts
│   │   │   │   │   └── health.ts
│   │   │   │   └── ws/
│   │   │   │       ├── handler.ts
│   │   │   │       └── events.ts
│   │   │   ├── mcp/                      # MCP Server (外部 AI 系统接入)
│   │   │   │   ├── server.ts
│   │   │   │   ├── tools/
│   │   │   │   │   ├── searchMemory.ts
│   │   │   │   │   ├── browseTimeline.ts
│   │   │   │   │   ├── lookupEntity.ts
│   │   │   │   │   ├── getEntityGraph.ts
│   │   │   │   │   ├── getScreenshotDetail.ts
│   │   │   │   │   └── getActivitySummary.ts
│   │   │   │   ├── resources/
│   │   │   │   │   ├── todaySummary.ts
│   │   │   │   │   ├── recentScreenshots.ts
│   │   │   │   │   ├── frequentEntities.ts
│   │   │   │   │   └── statsOverview.ts
│   │   │   │   └── transport/
│   │   │   │       ├── stdio.ts
│   │   │   │       └── streamableHttp.ts
│   │   │   ├── ingestion/
│   │   │   │   ├── pipeline.ts
│   │   │   │   ├── queue.ts
│   │   │   │   ├── processors/
│   │   │   │   │   ├── chineseTokenizer.ts    # 中文分词（jieba-wasm）
│   │   │   │   │   ├── entityExtractor.ts
│   │   │   │   │   ├── embedder.ts            # BGE-M3 向量化
│   │   │   │   │   ├── deduplicator.ts        # capture_id 幂等去重
│   │   │   │   │   └── contextEnricher.ts
│   │   │   │   └── adapters/
│   │   │   │       └── tesseract.ts           # 纯 TS OCR 降级方案
│   │   │   ├── agent/                    # AI Agent (AI SDK 编排, TDR-016)
│   │   │   │   ├── agent.ts             # AI SDK streamText + tools 主入口
│   │   │   │   ├── tools/
│   │   │   │   │   ├── vectorSearchTool.ts
│   │   │   │   │   ├── fullTextSearchTool.ts
│   │   │   │   │   ├── graphQueryTool.ts
│   │   │   │   │   ├── timeFilterTool.ts
│   │   │   │   │   ├── entityLookupTool.ts
│   │   │   │   │   ├── screenshotTool.ts
│   │   │   │   │   └── statsTool.ts
│   │   │   │   ├── memory/
│   │   │   │   │   ├── conversationMemory.ts
│   │   │   │   │   └── workingMemory.ts
│   │   │   │   └── prompts/
│   │   │   │       └── systemPrompt.ts
│   │   │   ├── search/
│   │   │   │   ├── engine.ts
│   │   │   │   ├── strategies/
│   │   │   │   │   ├── vectorSearch.ts
│   │   │   │   │   ├── fullTextSearch.ts
│   │   │   │   │   ├── graphSearch.ts
│   │   │   │   │   ├── timeRangeSearch.ts
│   │   │   │   │   └── hybridSearch.ts
│   │   │   │   └── ranker.ts
│   │   │   ├── ai/                       # AI Provider (纯模型调用)
│   │   │   │   ├── manager.ts
│   │   │   │   ├── providers/
│   │   │   │   │   ├── provider.ts
│   │   │   │   │   ├── ollama.ts
│   │   │   │   │   ├── openai.ts
│   │   │   │   │   └── anthropic.ts
│   │   │   │   ├── embedding/
│   │   │   │   │   ├── local.ts
│   │   │   │   │   └── remote.ts
│   │   │   │   └── ner/
│   │   │   │       ├── extractor.ts
│   │   │   │       └── patterns.ts
│   │   │   ├── storage/
│   │   │   │   ├── database.ts
│   │   │   │   ├── repositories/
│   │   │   │   │   ├── screenshotRepo.ts
│   │   │   │   │   ├── entityRepo.ts
│   │   │   │   │   ├── relationshipRepo.ts
│   │   │   │   │   ├── embeddingRepo.ts
│   │   │   │   │   ├── settingsRepo.ts
│   │   │   │   │   └── chatHistoryRepo.ts
│   │   │   │   ├── migrations/
│   │   │   │   │   ├── runner.ts
│   │   │   │   │   └── versions/
│   │   │   │   │       └── 001_initial.ts
│   │   │   │   └── schema/
│   │   │   │       └── surreal.ts
│   │   │   └── utils/
│   │   │       ├── logger.ts
│   │   │       ├── errors.ts
│   │   │       └── timing.ts
│   │   ├── tests/
│   │   │   ├── unit/
│   │   │   ├── integration/
│   │   │   └── fixtures/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── bunfig.toml
│   │
│   └── shared/                        # Shared Types & Utils
│       ├── src/
│       │   ├── index.ts               # Barrel export
│       │   ├── types/
│       │   │   ├── screenshot.ts
│       │   │   ├── entity.ts
│       │   │   ├── relationship.ts
│       │   │   ├── search.ts
│       │   │   ├── chat.ts
│       │   │   ├── timeline.ts
│       │   │   ├── settings.ts
│       │   │   └── events.ts
│       │   ├── constants/
│       │   │   ├── api.ts
│       │   │   ├── defaults.ts
│       │   │   └── limits.ts
│       │   └── utils/
│       │       ├── date.ts
│       │       └── validation.ts
│       ├── generated/
│       │   └── schemas/               # JSON Schema（zod-to-json-schema 生成）
│       ├── swift/
│       │   └── SharedTypes.swift      # Swift Codable 类型（quicktype 自动生成，勿手动编辑）
│       ├── package.json
│       └── tsconfig.json
│
├── scripts/                           # 🔧 构建与开发脚本
│   ├── build.sh                       # 完整构建
│   ├── dev.sh                         # 开发环境启动
│   ├── package-app.sh                 # 打包 .app
│   ├── create-dmg.sh                  # 创建 DMG
│   └── setup-models.sh               # 下载本地 AI 模型
│
└── .github/                           # CI/CD
    └── workflows/
        ├── ci.yml
        └── release.yml
```

---

## Monorepo Configuration

### Root `package.json`

> **注意：** `apps/` (Swift 项目) 不在 Turborepo workspaces 中。Swift 项目使用 Xcode/SPM 构建，通过 root scripts 中的 shell 命令编排。

```json
{
  "name": "recaply-sense",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "turbo run lint",
    "clean": "turbo run clean",
    "dev:engine": "cd packages/engine && bun run dev",
    "build:engine": "cd packages/engine && bun run build",
    "build:collector": "cd apps/collector && swift build -c release",
    "build:desktop": "cd apps/desktop && xcodebuild -scheme RecaplySense -configuration Release",
    "package:app": "bash scripts/package-app.sh"
  },
  "devDependencies": {
    "turbo": "^2",
    "typescript": "^5.7",
    "@types/bun": "latest"
  }
}
```

### `turbo.json`

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "test": {
      "dependsOn": ["build"]
    },
    "lint": {}
  }
}
```

### `packages/engine/package.json`

```json
{
  "name": "@recaply/engine",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/index.ts",
    "build": "bun build src/index.ts --outdir dist --target bun",
    "test": "bun test",
    "lint": "biome check src/",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "hono": "^4",
    "surrealdb": "^2",
    "@surrealdb/node": "^2",
    "@modelcontextprotocol/sdk": "^1",
    "zod": "^4",
    "ai": "^4",
    "@ai-sdk/openai": "^1",
    "@ai-sdk/anthropic": "^1",
    "ollama-ai-provider": "^1",
    "pino": "^9"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.7",
    "@biomejs/biome": "^1"
  }
}
```

### `packages/shared/package.json`

```json
{
  "name": "@recaply/shared",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "build": "bun build src/index.ts --outdir dist --target bun",
    "generate:types": "bun scripts/generate-swift-types.ts",
    "test": "bun test",
    "lint": "biome check src/"
  },
  "dependencies": {
    "zod": "^4",
    "zod-to-json-schema": "^3"
  },
  "devDependencies": {
    "typescript": "^5.7"
  }
}
```

---

## File Storage Layout (Runtime)

```
~/Library/Application Support/RecaplySense/
├── config.json                        # 用户配置
├── db/                                # SurrealDB 数据目录
│   └── surrealkv/                     # SurrealKV 存储引擎文件
├── screenshots/                       # 截图按日期组织
│   ├── 2026/
│   │   ├── 01/
│   │   │   ├── 01/
│   │   │   │   ├── 093012_a1b2c3.webp
│   │   │   │   ├── 093014_d4e5f6.webp
│   │   │   │   └── ...
│   │   │   ├── 02/
│   │   │   └── ...
│   │   ├── 02/
│   │   └── ...
│   └── ...
├── models/                            # AI 模型文件（本地降级时使用）
│   ├── bge-m3.onnx                    # Embedding 模型 (BGE-M3, ~1.1GB)
│   └── ...
└── logs/                              # 日志
    ├── engine.log
    ├── collector.log
    └── error.log

~/Library/Caches/RecaplySense/
├── thumbnails/                        # 缩略图缓存
│   ├── 320/                           # 320px 宽度
│   │   ├── a1b2c3.webp
│   │   └── ...
│   └── 160/                           # 160px 宽度
└── temp/                              # 临时文件
```

---

## File Naming Convention

### Screenshots

```
格式: HHMMSS_<short-hash>.webp
示例: 143012_a1b2c3.webp

路径: screenshots/{YYYY}/{MM}/{DD}/{HHMMSS}_{hash}.webp
完整: screenshots/2026/03/31/143012_a1b2c3.webp

hash: 基于 timestamp + 随机数的 6 位 hex
```

### Why this structure?

```
✅ 按日期分目录 → 避免单目录文件过多
✅ 精确到秒 → 快速按时间定位
✅ 短 hash → 避免同秒冲突
✅ 扁平日期 → 文件系统友好
✅ WebP → 最佳压缩率/质量比
```
