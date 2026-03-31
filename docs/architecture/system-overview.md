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
│  │  │  │  (REST+WS)  │  │(stdio/Stream) │  │ │                       │
│  │  │  │ 给内部 UI    │  │ 给外部 AI 系统 │  │ │                       │
│  │  │  └──────┬─────┘  └──────┬────────┘  │ │                       │
│  │  └─────────┼───────────────┼───────────┘ │                       │
│  │            │               │              │                       │
│  │  ┌─────────┐ ┌─────────┐ ┌────────────┐ │                       │
│  │  │ Ingestion│ │  Agent  │ │ AI Provider│ │                       │
│  │  │ Pipeline │ │(AI 智能体)│ │(LLM/Embed) │ │                       │
│  │  └────┬────┘ └────┬────┘ └─────┬──────┘ │                       │
│  │       │           │             │         │                       │
│  │  ┌─────────┐ ┌──────────────────────────┐│                       │
│  │  │ Search  │ │      Storage Layer       ││                       │
│  │  │ Engine  │ │  SurrealDB (embedded)    ││                       │
│  │  └─────────┘ │  文档·图·向量·全文         ││                       │
│  │              └──────────────────────────┘│                       │
│  └───────────────────────────────────────────┘                       │
│                                                                     │
│  ┌───────────────────────────────────────────┐                       │
│  │            File Storage                   │                       │
│  │  ~/Library/Application Support/           │                       │
│  │      RecaplySense/                        │                       │
│  │      ├── screenshots/    (截图原文件)       │                       │
│  │      ├── db/             (SurrealDB 数据)  │                       │
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
  ├── Agent (AI 智能体：意图理解 → 规划 → 工具调用 → 汇总)
  ├── Search Engine
  ├── AI Provider (LLM / Embedding)
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
                    │     人名·应用·URL·话题·项目     │
                    │                              │
                    │  3. Embedding 向量化           │
                    │     (BGE-M3 云端 API / 本地 ONNX) │
                    │                              │
                    │  4. 写入 SurrealDB             │
                    │     • screenshot 记录          │
                    │     • OCR 文本 + FTS 索引       │
                    │     • 向量嵌入                  │
                    │     • 实体节点 + 关系边          │
                    └──────────────────────────────┘


                    查询流程 (Read Path)
                    ═══════════════════

  User Query ──▶ Frontend ──HTTP──▶ Backend
                                      │
                    ┌────────────────────────────────────────────┐
                    │           Agent (AI 智能体)                 │
                    │                                            │
                    │  1. 🧠 意图理解 (Intent Parser)              │
                    │     LLM 分析用户查询，提取意图和约束          │
                    │                                            │
                    │  2. 📋 任务规划 (Task Planner)               │
                    │     分解为可执行的步骤序列                    │
                    │                                            │
                    │  3. 🔧 工具调用 (Tool Execution)             │
                    │     ┌──────────┐  ┌──────────────┐        │
                    │     │ 向量搜索   │  │ 全文搜索 (FTS)│        │
                    │     │ 语义相似   │  │ 精确匹配      │        │
                    │     └────┬─────┘  └──────┬───────┘        │
                    │          │               │                 │
                    │     ┌────▼───────────────▼────┐           │
                    │     │   图查询 (Graph Traverse) │           │
                    │     │   实体关联 · 时间范围       │           │
                    │     └────────────┬────────────┘           │
                    │                  │                         │
                    │  4. 🔀 结果融合 (Result Fusion & Rank)      │
                    │     合并 · 去重 · 交叉过滤 · 排序            │
                    │                                            │
                    │  5. 📝 生成回答 (Response Synthesis)         │
                    │     LLM 汇总搜索结果，生成自然语言回答       │
                    └────────────────────┬───────────────────────┘
                                         │
                               Response ◀┘
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
  ├── models/                   # 用户下载的额外模型
  ├── config.json               # 用户配置
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
