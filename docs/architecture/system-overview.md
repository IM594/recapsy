# Recaply Sense — System Architecture Overview

> Version: 0.1.0 | Last Updated: 2026-03-31

## 1. Vision

Recaply Sense 是一个 macOS 原生的个人记忆系统。它持续记录用户屏幕上发生的一切，
通过 AI 理解和索引这些记忆，让用户可以随时搜索、回忆和分析自己的数字生活。

**核心理念：**

- 被动记录，主动回忆
- 本地优先，隐私至上
- AI 增强，不是 AI 依赖

## 2. System Architecture (三端架构)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        RecaplySense.app                            │
│                     (macOS Application Bundle)                     │
│                                                                     │
│  ┌──────────────────┐   ┌───────────────────┐                      │
│  │   Frontend (UI)   │   │ Collector (采集器)  │                      │
│  │   SwiftUI App     │   │  Swift Daemon      │                      │
│  │                    │   │                     │                      │
│  │  • 时间线浏览       │   │  • ScreenCaptureKit │                      │
│  │  • 搜索界面         │   │  • 变化检测          │                      │
│  │  • AI 对话         │   │  • 智能截图          │                      │
│  │  • 设置面板         │   │  • 隐私过滤          │                      │
│  │  • 菜单栏常驻       │   │  • 截图压缩存储      │                      │
│  └────────┬─────────┘   └────────┬──────────┘                      │
│           │ HTTP/WS               │ HTTP POST                       │
│           │                       │ (screenshots + metadata)        │
│  ┌────────▼───────────────────────▼─────────┐                       │
│  │            Backend (Engine)               │                       │
│  │            TypeScript + Bun               │                       │
│  │                                           │                       │
│  │  ┌──────────────────────────────────────┐ │                       │
│  │  │      Protocol Adapters (入口层)       │ │                       │
│  │  │  ┌────────────┐  ┌───────────────┐  │ │                       │
│  │  │  │  HTTP API   │  │  MCP Server   │  │ │                       │
│  │  │  │  (REST+WS)  │  │(stdio/S.HTTP) │  │ │                       │
│  │  │  │ 给内部 UI    │  │ 给外部 AI 系统 │  │ │                       │
│  │  │  └──────┬─────┘  └──────┬────────┘  │ │                       │
│  │  └─────────┼───────────────┼───────────┘ │                       │
│  │            │               │              │                       │
│  │  ┌─────────┐ ┌─────────┐ ┌────────────┐ │                       │
│  │  │ Ingestion│ │  Agent  │ │ AI Provider│ │                       │
│  │  │ Pipeline │ │(AI 智能体)│ │(LLM/Embed) │ │                       │
│  │  └────┬────┘ └────┬────┘ └─────┬──────┘ │                       │
│  │       │           │             │         │                       │
│  │  ┌─────────┐ ┌──────────┐ ┌───────────┐ │                       │
│  │  │ Vision  │ │  Search  │ │  Storage  │ │                       │
│  │  │  LLM    │ │  Engine  │ │  Layer    │ │                       │
│  │  │(活动摘要)│ │          │ │ SurrealDB │ │                       │
│  │  └─────────┘ └──────────┘ │ 文档·图·向量·全文 │ │                       │
│  │                           └───────────┘ │                       │
│  └───────────────────────────────────────────┘                       │
│                                                                     │
│  ┌───────────────────────────────────────────┐                       │
│  │            File Storage                   │                       │
│  │  ~/Library/Application Support/           │                       │
│  │      RecaplySense/                        │                       │
│  │      ├── screenshots/    (截图原文件)       │                       │
│  │      ├── db/             (SurrealDB 数据)  │                       │
│  │      ├── rem/            (REM（知识沉淀层）MD 文件)  │                       │
│  │      └── models/         (本地 AI 模型)     │                       │
│  └───────────────────────────────────────────┘                       │
└─────────────────────────────────────────────────────────────────────┘
```

## 3. Process Architecture

```
用户安装 RecaplySense.app 后：

进程 1: recaply-engine (后端服务，launchd 托管)
  ├── HTTP/WS Server (Hono on Bun)
  ├── Ingestion Pipeline
  ├── Vision LLM (App Session → 活动摘要, TDR-019)
  ├── REM Layer (日摘要/周回顾/用户记忆, TDR-021)
  ├── Agent (AI SDK streamText + tools, TDR-016)
  ├── Search Engine
  ├── AI Provider (LLM / Embedding / Vision)
  └── SurrealDB (embedded)

进程 2: recaply-collector (采集器守护进程，launchd 托管)
  ├── Screen Capture Loop
  ├── Change Detection
  ├── Privacy Filter
  ├── OCR (Apple Vision 文本提取)
  └── Screenshot Storage

进程 3: RecaplySense (UI 客户端，用户按需打开)
  ├── SwiftUI UI (前端)
  ├── 连接 Engine API/WS
  └── 菜单栏图标

启动流程（launchd 托管模型）：
  首次安装 → App 注册 Engine + Collector 为 LaunchAgent (SMAppService)
  开机/登录 → launchd 自动启动 Engine + Collector
  App 打开 → UI 连接已运行的 Engine
  App 关闭 → UI 退出，Engine + Collector 继续后台运行
  崩溃恢复 → launchd 自动重启崩溃进程
```

## 4. Data Flow

### 4.1 全局数据流图

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              RecaplySense 全局数据流                              │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│   ┌────────────────────────── 写入路径 (Write) ──────────────────────────┐      │
│   │                                                                      │      │
│   │   Screen                                                             │      │
│   │     │ 2s/帧                                                          │      │
│   │     ▼                                                                │      │
│   │   Collector (Swift Daemon)                                           │      │
│   │     │                                                                │      │
│   │     ├─ 1. ScreenCaptureKit 截屏                                      │      │
│   │     ├─ 2. 像素差异检测（< 5% 跳过）                                    │      │
│   │     ├─ 3. WebP 压缩 ─────────────────────────▶ ~/screenshots/{日期}/  │      │
│   │     ├─ 4. Apple Vision OCR                                           │      │
│   │     └─ 5. HTTP POST ──────────────────────────────┐                  │      │
│   │          (path, metadata, ocr_text, context)       │                  │      │
│   │                                                    │                  │      │
│   │   Engine (TypeScript + Bun)                        │                  │      │
│   │     │◀─────────────────────────────────────────────┘                  │      │
│   │     │                                                                │      │
│   │     ├─── Ingestion Pipeline ──────────────────────────────────────┐  │      │
│   │     │    │                                                        │  │      │
│   │     │    ├─ 1. 中文预分词 (jieba-wasm)                              │  │      │
│   │     │    ├─ 2. NER 实体提取                                        │  │      │
│   │     │    │    Level 1: 本地规则匹配（~80%）                          │  │      │
│   │     │    │    Level 2: 云端 LLM（规则未覆盖时）                       │  │      │
│   │     │    ├─ 3. Embedding (BGE-M3 云端/本地)                         │  │      │
│   │     │    └─ 4. withTransaction 原子写入 ────▶ SurrealDB            │  │      │
│   │     │         • screenshot 记录                    ┌──────────┐   │  │      │
│   │     │         • OCR 全文索引 (FTS)                 │          │   │  │      │
│   │     │         • 向量嵌入 (HNSW)                    │ SurrealDB│   │  │      │
│   │     │         • entity 节点 + appeared_in 边       │  (嵌入式) │   │  │      │
│   │     │                                              │          │   │  │      │
│   │     │    EventBus: ingestion:done ──────┐          │ 文档存储  │   │  │      │
│   │     │                                   │          │ 图关系    │   │  │      │
│   │     ├─── Vision 模块 ◀──────────────────┘          │ 向量索引  │   │  │      │
│   │     │    │                                         │ 全文搜索  │   │  │      │
│   │     │    ├─ 1. App Session 管理                    │          │   │  │      │
│   │     │    │    (bundle_id 切换 → session 结束)       │          │   │  │      │
│   │     │    ├─ 2. OCR 文本去重 + 代表帧选择 (≤8帧)     └──────────┘   │  │      │
│   │     │    ├─ 3. Vision LLM 结构化输出                      ▲        │  │      │
│   │     │    └─ 4. 写入 activity_segment ─────────────────────┘        │  │      │
│   │     │                                                              │  │      │
│   │     └──────────────────────────────────────────────────────────────┘  │      │
│   └──────────────────────────────────────────────────────────────────────┘      │
│                                                                                 │
│   ┌────────────────────────── 查询路径 (Read) ───────────────────────────┐      │
│   │                                                                      │      │
│   │   Frontend (SwiftUI)     Claude/Cursor (外部 AI)                     │      │
│   │     │                       │                                        │      │
│   │     │ HTTP/WS               │ MCP (stdio / Streamable HTTP)          │      │
│   │     │ :21890                │ :21891                                  │      │
│   │     ▼                       ▼                                        │      │
│   │   ┌──────────┐         ┌──────────┐                                  │      │
│   │   │ REST API │         │MCP Server│                                  │      │
│   │   │ (Hono)   │         │(原始工具) │                                  │      │
│   │   └────┬─────┘         └────┬─────┘                                  │      │
│   │        │                    │                                        │      │
│   │        │  ┌─────────────────┘                                        │      │
│   │        │  │                                                          │      │
│   │        ▼  ▼                                                          │      │
│   │   ┌───────────────────────────────────────────────────────────┐      │      │
│   │   │                    查询引擎层                                │      │      │
│   │   │                                                           │      │      │
│   │   │  Agent (仅 REST)           Search Engine (REST + MCP)     │      │      │
│   │   │  AI SDK streamText         ┌──────┐ ┌──────┐ ┌──────┐   │      │      │
│   │   │  + tool calling            │向量搜索│ │FTS搜索│ │图查询 │   │      │      │
│   │   │  maxSteps=10               └──┬───┘ └──┬───┘ └──┬───┘   │      │      │
│   │   │                               └────┬───┘────────┘        │      │      │
│   │   │                                    ▼                     │      │      │
│   │   │                              Hybrid Ranker               │      │      │
│   │   │                              (多路融合排序)                │      │      │
│   │   └───────────────────────┬───────────────────────────────────┘      │      │
│   │                           │                                          │      │
│   │                           ▼                                          │      │
│   │                      SurrealDB                                       │      │
│   │                   (读取 + 搜索)                                       │      │
│   │                                                                      │      │
│   └──────────────────────────────────────────────────────────────────────┘      │
│                                                                                 │
│   ┌───────────────────── 后台任务 (Scheduler) ───────────────────────────┐      │
│   │                                                                      │      │
│   │   screenshotCleanup  backupDaily  deadLetterScan  visionRetry      │      │
│   │   dailySummary       weeklySummary                                 │      │
│   │   (截图清理/备份/死信重试/Vision重试/日摘要/周回顾)                  │      │
│   │        │                  │              │                │          │      │
│   │        └──────────────────┴──────────────┴────────────────┘          │      │
│   │                           │                                          │      │
│   │                           ▼                                          │      │
│   │                  storage / ingestion / vision / rem                        │      │
│   │                                                                      │      │
│   └──────────────────────────────────────────────────────────────────────┘      │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘

数据存储概览：
  ~/Library/Application Support/RecaplySense/
  ├── screenshots/    Collector 直接写入，Engine 通过 path 引用
  ├── db/             SurrealDB 数据（文档 + 图 + 向量 + FTS）
  ├── models/         本地 AI 模型 (BGE-M3 ONNX)
  ├── rem/            REM 层文件（日摘要/周回顾/用户记忆）
  ├── backups/        自动/手动备份
  ├── logs/           Pino JSON 日志
  └── collector_buffer.sqlite   Collector 离线缓冲
```

### 4.2 录制流程 (Write Path) 详解

```
                    录制流程 (Write Path)
                    ═══════════════════

  Screen ──2s──▶ Collector ──diff──▶ 变化检测
                                   │
                          ┌────────▼────────┐
                          │  有变化？          │
                          │  No → 跳过        │
                          │  Yes → 继续 ↓     │
                          └────────┬────────┘
                                   │
                    截图压缩存储 (WebP) ──▶ ~/screenshots/
                                   │
                    OCR 文本提取 (Apple Vision)
                                   │
                    HTTP POST ─────▶ Backend
                     (path + metadata + ocr_text)
                                   │
                    ┌──────────────▼──────────────┐
                    │     Ingestion Pipeline       │
                    │                              │
                    │  1. 中文预分词                  │
                    │     (对 ocr_text 做中文分词)    │
                    │                              │
                    │  2. 实体提取 (NER)             │
                    │     Level 1: 本地规则 (~80%)  │
                    │     Level 2: 云端 LLM (降级)  │
                    │                              │
                    │  3. Embedding 向量化           │
                    │     (BGE-M3 云端 API / 本地 ONNX) │
                    │                              │
                    │  4. withTransaction 写入 SurrealDB │
                    │     • screenshot 记录          │
                    │     • OCR 文本 + FTS 索引       │
                    │     • 向量嵌入                  │
                    │     • 实体节点 + 关系边          │
                    └──────────────┬───────────────┘
                                   │
                    EventBus: ingestion:done
                                   │
                    ┌──────────────▼──────────────┐
                    │   Vision LLM 处理 (TDR-019)  │
                    │   (异步, App Session 触发)    │
                    │                              │
                    │  1. App Session 管理          │
                    │     检测 App 切换 → Session 结束│
                    │                              │
                    │  2. OCR 文本去重 + 代表帧选择  │
                    │     相似度 > 70% 的帧跳过      │
                    │     选择 ≤ 8 张代表帧          │
                    │                              │
                    │  3. Vision LLM 调用           │
                    │     发送代表帧图片 → 结构化输出  │
                    │                              │
                    │  4. 写入 activity_segment      │
                    │     • 活动描述 + 场景分类       │
                    │     • 实体 + 向量嵌入           │
                    └──────────────────────────────┘
```

### 4.3 查询流程 (Read Path) 详解

```
                    查询流程 (Read Path)
                    ═══════════════════

  User Query ──▶ Frontend ──HTTP──▶ Backend
                                      │
                    ┌────────────────────────────────────────────┐
                    │     Agent (AI SDK streamText + tools)      │
                    │                                            │
                    │  LLM 自行规划 tool calling 序列 (TDR-016) │
                    │                                            │
                    │  可用工具：                                  │
                    │  ┌──────────┐ ┌──────────────┐            │
                    │  │ 向量搜索  │ │ 全文搜索 (FTS)│            │
                    │  └────┬─────┘ └──────┬───────┘            │
                    │  ┌────▼──────────────▼────┐               │
                    │  │  图查询 · 时间过滤       │               │
                    │  │  实体查找 · 截图详情      │               │
                    │  │  活动片段搜索 (TDR-019)  │               │
                    │  └────────────┬────────────┘               │
                    │               │                             │
                    │  LLM 汇总结果，流式返回自然语言回答          │
                    └────────────────────┬───────────────────────┘
                                         │
                               Response ◀┘


  Claude/Cursor ──MCP──▶ MCP Server (原始工具，非 Agent)
                              │
                              ├─ search_memory      → search/
                              ├─ browse_timeline    → storage/
                              ├─ lookup_entity      → storage/
                              ├─ get_entity_graph   → storage/ (图查询)
                              ├─ get_screenshot_detail → storage/
                              └─ get_activity_summary  → storage + search/
```

## 5. Technology Stack Summary

```
┌────────────────────────────────────────────────────────────┐
│ Layer              │ Technology           │ Why             │
├────────────────────┼──────────────────────┼─────────────────┤
│ macOS UI           │ SwiftUI              │ 原生，性能最佳    │
│ Menu Bar           │ SwiftUI MenuBarExtra │ 系统级常驻       │
│ Screen Capture     │ ScreenCaptureKit     │ Apple 原生 API   │
│ OCR                │ Apple Vision         │ Collector端执行    │
│ Backend Runtime    │ Bun                  │ 快，TS 原生      │
│ HTTP Framework     │ Hono                 │ 轻量，Bun 优化   │
│ WebSocket          │ Bun native WS        │ 内置支持         │
│ Database           │ SurrealDB            │ 多模型一体       │
│ Embedding (cloud)  │ BGE-M3 API           │ 中英双语，1024维 │
│ Embedding (local)  │ BGE-M3 ONNX          │ 离线降级         │
│ Embedding Model    │ BAAI/bge-m3          │ 多语言100+，同模型│
│ LLM (local)        │ Ollama               │ 本地推理（可选） │
│ LLM (cloud)        │ OpenAI / Anthropic   │ 云端推理（默认） │
│ Vision LLM         │ Provider 可切换      │ 截图理解 (TDR-019)│
│ AI SDK             │ Vercel AI SDK        │ Agent 编排+多 Provider │
│ MCP                │ @modelcontextprotocol/sdk │ stdio + Streamable HTTP │
│ Image Format       │ WebP                 │ 压缩率高质量好   │
│ IPC                │ HTTP REST + WS       │ 通用跨平台       │
│ Build (Swift)      │ Xcode / SPM          │ Apple 标准       │
│ Build (TS)         │ Bun                  │ 零配置           │
│ Monorepo           │ Turborepo            │ 多包管理         │
└────────────────────────────────────────────────────────────┘
```

## 6. Deployment Model

```
安装：
  用户下载 RecaplySense.dmg → 拖到 Applications → 完成
  首次启动自动：
    1. 请求屏幕录制权限
    2. 初始化 SurrealDB
    3. 下载本地 AI 模型（如需要）
    4. 启动后端服务 + 采集端

文件布局：
  /Applications/RecaplySense.app/
  ├── Contents/MacOS/
  │   ├── RecaplySense          # 主进程 (SwiftUI)
  │   ├── recaply-collector     # 采集器 (Swift CLI)
  │   ├── recaply-engine        # 后端 (Bun bundle)
  │   └── bun                   # Bun runtime (bundled)
  ├── Contents/Resources/
  │   ├── models/               # 本地 AI 模型
  │   └── surreal               # SurrealDB binary
  └── Contents/Info.plist

  ~/Library/Application Support/RecaplySense/
  ├── screenshots/              # 截图存储
  │   ├── 2026/03/31/           # 按日期分目录
  │   │   ├── 143012_abc123.webp
  │   │   └── 143014_def456.webp
  │   └── ...
  ├── db/                       # SurrealDB 数据文件
  ├── rem/                      # REM 层 MD 文件
  │   ├── daily/                # 日摘要（Routine 自动生成）
  │   ├── weekly/               # 周回顾（Routine 自动生成）
  │   └── memory.md             # 用户记忆
  ├── models/                   # 用户下载的额外模型
  ├── backups/                  # 自动/手动备份
  ├── config.json               # 用户配置
  ├── collector_buffer.sqlite   # Collector 离线缓冲（Engine 不可达时）
  └── logs/                     # 日志文件

  ~/Library/Caches/RecaplySense/
  └── thumbnails/               # 缩略图缓存（由 Engine API 按需生成）
```

## 7. Security & Privacy

```
核心原则：
  1. 数据默认本地存储，永不自动上传
  2. 云端 API 调用需用户显式授权
  3. 隐私排除列表（不录制特定应用/窗口）
  4. 数据加密存储（可选）
  5. macOS 屏幕录制权限系统集成

隐私控制层级：
  L1: 应用级排除 — 完全不录制指定应用
  L2: 窗口级排除 — 不录制含敏感标题的窗口
  L3: 内容级排除 — 检测并模糊密码输入框
  L4: 时间级排除 — 设置勿扰时间段
```

## 8. Scalability Considerations

```
10 年数据量规划（24h × 2s/帧）：

截图存储：
  • 智能去重后：~1-3 GB/天 → ~3.6-10 TB/10年
  • 策略：按日期分目录，支持外接硬盘/NAS 冷存储
  • 压缩：WebP 质量自适应（活跃窗口高质量，静止窗口低质量）

SurrealDB 数据：
  • OCR 文本 + 元数据 + 向量 + 图：~50-100 MB/天
  • 10 年：~180-360 GB
  • 策略：SurrealDB 支持 surrealkv 存储引擎，大数据量可分库

性能优化：
  • 采集端：变化检测避免重复截图（可减少 60-80% 数据量）
  • 写入：批量写入 SurrealDB，不逐条
  • 查询：时间范围预过滤 + 向量/全文/图三路并行搜索
  • 内存：截图不经过后端内存，Collector 直接写磁盘
```
