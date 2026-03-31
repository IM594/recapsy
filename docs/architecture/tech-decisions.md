# Recaply Sense — Tech Decisions Record

> Version: 0.1.0 | Last Updated: 2026-03-31

本文档记录了项目中所有重要的技术决策，包含决策原因和被否决的备选方案。

---

## TDR-001: 三端架构（Frontend + Collector + Engine）

**决策：** 系统分为前端(UI)、采集端(Collector)、后端(Engine) 三个独立模块。

**原因：**

- 采集端必须平台原生（屏幕录制 API 每个 OS 不同）
- 后端逻辑（AI、搜索、存储）跨平台通用
- 前后端分离后，后端可独立部署到云端
- 扩展新平台只需新写采集端和前端，后端复用

**否决方案：**

- ❌ 单体 App — 扩展性差，无法跨平台复用
- ❌ 两端架构 — 采集端和后端合并时，云端部署受限

---

## TDR-002: macOS 前端使用 SwiftUI

**决策：** macOS 前端使用 SwiftUI 原生开发。

**原因：**

- macOS 原生体验最佳（动画、系统集成、菜单栏）
- 性能开销最小
- ScreenCaptureKit 等系统 API 直接调用
- 目前只做 macOS，无需跨平台

**否决方案：**

- ❌ Electron — 资源占用高（~150MB+），不符合"轻量"目标
- ❌ Tauri — Rust 学习曲线，且 macOS 原生集成不如 SwiftUI

---

## TDR-003: 后端使用 TypeScript + Bun

**决策：** 后端 Engine 使用 TypeScript，运行在 Bun runtime 上。

**原因：**

- 开发者最熟悉 TypeScript，开发效率最高
- AI 代码生成 TypeScript 质量高（90%+ 一次通过）
- AI/ML 生态丰富（LangChain.js、OpenAI SDK、Vercel AI SDK）
- Bun 性能接近 Go，启动速度快，内置 TS 支持
- 资源占用（~50MB 空闲）在 macOS 上可接受
- 后端与前端解耦，不需要和 Swift 同语言

**否决方案：**

- ❌ Rust — AI 代码生成质量差（~50-60% 通过率），开发慢
- ❌ Go — 可以接受，但 TS 更熟悉，AI 生态更好
- ❌ Swift (Vapor) — Linux 支持不完善，云部署不便
- ❌ Python — 资源占用较高，类型安全弱

---

## TDR-004: 使用 SurrealDB 作为统一存储

**决策：** 使用 SurrealDB 作为唯一数据库，利用其多模型能力。

**原因：**

- 一个 DB 覆盖文档存储 + 图关系 + 向量搜索 + 全文搜索
- Rust 编写，性能好
- 支持嵌入式运行（零额外进程）和独立服务
- 支持本地部署和云端部署
- 31K GitHub Stars，社区活跃
- BSL 1.1 许可，个人/商业使用完全免费
- 丰富的查询语言（SurrealQL），支持图遍历

**否决方案：**

- ❌ SQLite + sqlite-vec — 需要多个扩展拼凑，无图查询
- ❌ SQLite + Kuzu — Kuzu 已归档（团队转型）
- ❌ Neo4j — Java/JVM，常驻 2-8GB 内存，太重
- ❌ PostgreSQL + pgvector — 需要运行数据库服务，部署复杂
- ❌ CozoDB — 开发放缓，需学 Datalog
- ❌ FalkorDB — 需要运行 Redis 服务

**风险：**

- SurrealDB 相对年轻，API 可能有 breaking changes
- 缓解：Repository 抽象层隔离数据库细节，必要时可替换

---

## TDR-005: AI 分层策略（云端默认 + 本地降级）

**决策：** OCR 在 Collector（Swift）端本地运行；Embedding、NER、LLM 默认使用云端 API（效果优先），
保留本地降级方案满足离线需求。LLM Provider 不预设默认值，首次启动时引导用户选择。

**组件分配：**
| 功能 | 默认（云端） | 降级（本地） |
|------|-------------|-------------|
| OCR | — | Apple Vision（Collector 端执行，见 TDR-017） |
| Embedding | BGE-M3 云端 API（1024 维） | BGE-M3 ONNX（1024 维，模型 ~1.1GB） |
| NER (实体提取) | 云端 LLM 提取 | 本地规则匹配 |
| LLM (Agent/对话) | OpenAI / Anthropic（用户首次启动时选择） | Ollama（可选） |

**Embedding 模型选型：**

- BGE-M3（BAAI 开源）：多语言 100+ 语言，1024 维，8192 tokens 上下文
- 云端和本地使用同一模型，向量完全兼容，切换在线/离线模式不需要重建索引
- 支持 dense + sparse + ColBERT 三种检索模式，sparse 输出可弥补 SurrealDB 缺少中文全文分词的问题
- 中英文质量在 MTEB/MIRACL 多语言 benchmark 上优于 OpenAI text-embedding-3 系列

**原因：**

- OCR 使用 Apple Vision 在 Swift 中调用最自然，且为 CPU 密集操作，分布到 Collector 端减轻 Engine 负载
- Embedding 云端/本地同模型，避免向量不兼容导致索引重建
- Agent 编排、意图理解、回答合成需要强推理能力，本地模型效果差距明显
- 不预设 LLM Provider，尊重用户偏好和已有 API Key
- 本地 Ollama 保留为可选项，满足完全离线需求

**风险：**

- `onnxruntime-node` 是 Node.js N-API native addon，与 Bun 的兼容性在特定版本组合下可能有问题
- 缓解：降级到远程 Embedding API，或使用 `@xenova/transformers` 纯 JS 实现

**否决方案：**

- ❌ 纯云端 — 隐私风险，持续 API 费用
- ❌ 纯本地 — LLM 能力受限，复杂查询效果差
- ❌ BGE-small-en-v1.5 — 仅支持英文，不适合中文产品
- ❌ OpenAI text-embedding-3-small 做默认 — 云端/本地模型不同，切换时向量不兼容需重建索引

---

## TDR-006: HTTP REST + WebSocket 通信

**决策：** 模块间通信使用 HTTP REST（CRUD）+ WebSocket（实时推送）。

**原因：**

- REST 最通用，Swift/TS/任何语言都能调用
- WebSocket 支持流式 AI 回复和实时通知
- 调试方便（curl、Postman）
- 后续加 Web UI / CLI 客户端无额外成本

**否决方案：**

- ❌ gRPC — 调试不便，Swift 集成需额外库
- ❌ tRPC — 仅限 TypeScript 客户端
- ❌ Unix Socket — 不支持跨网络（云端部署）

---

## TDR-007: 截图使用 WebP 格式

**决策：** 截图压缩为 WebP 格式存储。

**原因：**

- WebP 同等质量下比 PNG 小 25-35%，比 JPEG 小 25-34%
- 支持有损和无损压缩
- 可以动态调整质量（活跃窗口 quality=80，静止 quality=40）
- macOS 和所有现代浏览器原生支持

**否决方案：**

- ❌ PNG — 文件太大，24h 录制存储压力大
- ❌ JPEG — 文字截图质量差（有锯齿）
- ❌ AVIF — 编码速度慢，Swift 支持不完善

---

## TDR-008: Hono 作为 HTTP 框架

**决策：** 后端 HTTP 框架使用 Hono。

**原因：**

- 专为 Bun/Edge Runtime 优化
- 极轻量（~14KB），零依赖
- Express 风格 API，上手零成本
- 中间件生态丰富
- TypeScript 优先，路由类型安全

**否决方案：**

- ❌ Express — 老旧，不针对 Bun 优化
- ❌ Fastify — 较重，Bun 兼容性不完美
- ❌ Elysia — 专为 Bun 设计但装饰器风格 API 可读性差

---

## TDR-009: Biome 作为 Linter/Formatter

**决策：** 使用 Biome 替代 ESLint + Prettier。

**原因：**

- Rust 编写，速度极快（比 ESLint 快 10-20x）
- Linter + Formatter 合一，零配置
- 与 Bun 生态契合

---

## TDR-010: Turborepo 管理 Monorepo

**决策：** 使用 Turborepo 管理 TypeScript 包的构建编排。

**原因：**

- 增量构建，只重建变更部分
- 构建缓存，重复构建秒级完成
- 简单配置
- Swift 项目（apps/desktop, apps/collector）独立用 Xcode/SPM 构建

**否决方案：**

- ❌ Nx — 功能强大但配置复杂，个人项目 overkill
- ❌ Lerna — 已停止维护主要功能
- ❌ pnpm workspace — 可以，但缺少构建编排

---

## TDR-011: 端口号 21890

**决策：** Engine 默认监听 `localhost:21890`。

**原因：**

- 21890 不与常见服务冲突
- 易记："2" + "1890"（recall + 年份感）
- 仅绑定 localhost，安全
- 可通过配置文件修改

---

## TDR-012: 截图变化检测策略

**决策：** Collector 使用像素级差异检测来决定是否保存截图。

**策略：**

```
1. 每 2 秒截取一帧
2. 与上一帧做像素差异比较（降采样后）
3. diff_ratio < 0.05 (5%) → 跳过，认为无变化
4. diff_ratio >= 0.05 → 保存截图，发送给 Engine
5. 连续 30 次无变化 → 降频到 10 秒一次
6. 检测到变化 → 恢复 2 秒频率
```

**原因：**

- 大部分时间屏幕是静止的（阅读、思考）
- 5% 阈值过滤微小变化（光标闪烁、时钟更新）
- 自适应频率进一步减少 60-80% 的截图量
- 在 Collector 端做，避免无用数据传到 Engine

---

## TDR-013: 命名规范 — Collector vs Agent

**决策：**

- 屏幕采集守护进程命名为 `collector`（采集器）
- Engine 内部的 AI 智能体命名为 `agent`

**原因：**

- "Agent" 在 AI 领域有明确含义：自主推理、规划、工具调用的智能体
- 屏幕采集进程是简单的数据收集器，不具备 AI 能力，用 "Agent" 不准确
- `collector` 精确描述其职责：采集屏幕数据、写文件、通知后端
- `agent` 保留给真正的 AI 智能体：理解用户意图 → 规划任务 → 调用工具 → 合成回答
- 语义清晰，避免混淆

**否决方案：**

- ❌ "recorder" — 容易和屏幕录像（视频）混淆
- ❌ "sensor" — 偏硬件含义
- ❌ "watcher" — 偏监控含义

---

## TDR-014: MCP Server 只暴露原始能力，不暴露 Agent

**决策：** MCP Server 只暴露底层原始工具（search, entity, timeline 等），
不暴露内部 Agent 的编排能力。

**MCP Tools 清单：**
| Tool | 功能 | 调用的内部模块 |
|------|------|---------------|
| `search_memory` | 向量/全文/混合搜索 | search |
| `browse_timeline` | 按时间浏览截图 | storage |
| `lookup_entity` | 查找实体详情+关联 | storage |
| `get_entity_graph` | 实体关系图 | storage (graph query) |
| `get_screenshot_detail` | 截图+OCR文本 | storage |
| `get_activity_summary` | 活动统计摘要 | storage + search |

**MCP Resources 清单：**
| Resource URI | 功能 |
|---|---|
| `recaply://today/summary` | 今日活动摘要 |
| `recaply://recent/screenshots` | 最近截图 OCR 文本 |
| `recaply://entities/frequent` | 高频实体列表 |
| `recaply://stats/overview` | 系统总览统计 |

**原因：**

- 外部 AI 系统（Claude/Cursor）自己就是 Agent，已具备意图理解和任务编排能力
- 暴露 Agent 会导致"Agent 套 Agent"：外部 Agent → 内部 Agent → 双重 LLM 推理
- 暴露原始工具让外部 Agent 自由编排，更灵活、更快、更省成本
- 原始数据直接返回，无信息经过内部 LLM"消化"的损失

**内部 Agent 仍然保留，服务于：**

- Frontend Chat 界面（App 内的 AI 对话，没有外部 Agent 帮忙编排）
- 未来可能的 CLI 客户端

**否决方案：**

- ❌ 暴露 `ask_memory` Agent 工具 — 导致双重 Agent，冗余且慢

---

## TDR-015: Swift ↔ TypeScript 类型同步方案

**决策：** 使用 Zod → JSON Schema → quicktype 工具链自动生成 Swift Codable 类型。

**流程：**

```
shared/src/types/*.ts (Zod schema，Single Source of Truth)
           │
           ▼
  zod-to-json-schema (bun 脚本)
           │
           ▼
  shared/generated/schemas/*.json (JSON Schema 中间产物)
           │
           ▼
  quicktype --lang swift --src-lang schema
           │
           ▼
  shared/swift/SharedTypes.swift (自动生成，不手动编辑)
```

**触发时机：**

- `bun run generate:types` — 手动执行
- CI 中自动执行并检查 diff，确保提交前已同步

**原因：**

- Zod schema 已是项目中类型定义的 source of truth，不引入额外定义层
- quicktype 生成的 Swift Codable 类型自带 JSON encode/decode，直接可用
- JSON Schema 作为中间产物，未来也可用于 API 文档生成
- 完全自动化，避免手动同步遗漏

**否决方案：**

- ❌ 手动同步 — 类型增多后一致性无法保证
- ❌ OpenAPI spec — 前期配置重，且项目不是 API-first 设计
- ❌ protobuf — 引入额外序列化层，过度设计

---

## TDR-016: Agent 编排层使用 Vercel AI SDK

**决策：** 使用 Vercel AI SDK (`ai` 包) 作为 Agent 编排和 LLM 调用的统一抽象层。

**影响范围：**

- `agent/` — 用 AI SDK 的 `generateText` / `streamText` + tool calling 替代自建编排逻辑
- `ai/` — Provider 适配层大幅简化，AI SDK 内置 OpenAI / Anthropic / Ollama 适配器
- `ingestion/` — NER 实体提取可复用 AI SDK 的 `generateObject`（structured output）

**简化前后对比：**

```
之前（自建编排）:
  agent/intentParser.ts → agent/taskPlanner.ts → agent/executor.ts → agent/synthesizer.ts
  ai/providers/ollama.ts, openai.ts, anthropic.ts（手写适配）

之后（AI SDK）:
  agent/agent.ts — 用 AI SDK streamText + tools 实现完整编排
  agent/tools/*.ts — 注册为 AI SDK tool（schema 用 Zod 定义）
  ai/providers.ts — 一个文件，按配置返回 AI SDK provider 实例
```

**原因：**

- AI SDK 统一了 OpenAI / Anthropic / Ollama 的接口，保持 Provider 可切换
- 内置 tool calling、streaming、structured output，不需要自己处理各厂商差异
- 与 Bun 兼容，社区活跃，Vercel 持续维护
- Zod schema 直接用于 tool 参数校验，与项目技术栈完全对齐

**否决方案：**

- ❌ Claude Agent SDK — 深度绑定 Anthropic，不符合 Provider 可切换的设计
- ❌ OpenAI Agents SDK — 深度绑定 OpenAI，同上
- ❌ LangChain — 抽象层过重，runtime 依赖多，与 Bun 兼容性不如 AI SDK

---

## TDR-017: OCR 归属 Collector 端

**决策：** OCR 文本提取在 Collector（Swift 端）执行，Engine 不直接依赖 Apple Vision。
Collector POST 截图通知时附带 `ocr_text` 字段。

**影响范围：**

- Collector：新增 OCR 模块，调用 Apple Vision 提取文本后随截图元数据一起 POST 给 Engine
- Engine `ingestion/`：移除 `adapters/appleVision.ts`，OCR 步骤变为"接收已提取的文本"
- Engine 保留 `adapters/tesseract.ts` 作为纯 TS fallback（当 Collector 未提供 OCR 文本时降级）

**原因：**

- Apple Vision 是 Swift/Objective-C 框架，TS/Bun 不能直接 import，需要额外原生桥接层
- Engine 定位为可复用的跨平台核心，不应依赖 macOS 专属能力（TDR-001 三端架构的核心前提）
- Collector 本身就是 Swift 进程，调用 Apple Vision 零额外成本
- OCR 是 CPU 密集操作，分布到 Collector 端可减轻 Engine 负载
- 未来加其他平台（Windows/Linux）只需在该平台的 Collector 中实现对应 OCR

**否决方案：**

- ❌ Engine 内通过子进程调用 Swift CLI 执行 OCR — 增加进程管理复杂度
- ❌ Bun FFI 调用 Apple Vision — bun:ffi 仅面向 C ABI 且仍是 experimental
- ❌ 仅用 Tesseract.js — 中文 OCR 质量显著低于 Apple Vision

---

## TDR-018: 进程生命周期托管模型

**决策：** 采用 SMAppService / LaunchAgent 模型。Engine 和 Collector 作为系统服务独立运行，
Frontend（SwiftUI）仅作为 UI 客户端连接已运行的服务，不负责启动/停止后端进程。

**进程托管方式：**

```
安装时（首次启动或 App 更新后）：
  Frontend 注册 Engine 和 Collector 为 LaunchAgent（通过 SMAppService）
  → launchd 负责进程启动、崩溃恢复、开机自启

运行时：
  进程 1: recaply-engine    — launchd 托管，常驻后台
  进程 2: recaply-collector — launchd 托管，常驻后台
  进程 3: RecaplySense UI   — 用户按需打开/关闭，连接 Engine API

生命周期：
  App 打开  → UI 连接 Engine WS，展示数据
  App 关闭  → UI 退出，Engine + Collector 继续后台运行
  用户暂停  → 通过 API 发 collector:pause，Collector 停止截图但进程不退出
  完全退出  → 用户在设置中选择"停止后台服务"，注销 LaunchAgent
```

**原因：**

- Frontend 定义为"纯 UI 不含业务逻辑"，不应承担进程生命周期管理
- "UI 拉起的子进程" 和 "独立后台服务" 是完全不同的托管模型，崩溃恢复、升级、单实例约束都不一样
- SMAppService 是 Apple 推荐的 macOS 后台服务注册方式（macOS 13+）
- launchd 提供崩溃自动重启、开机自启、资源限制等能力

**否决方案：**

- ❌ App-only（退出即停止一切）— 用户关窗口就丢失录制，不符合"被动记录"理念
- ❌ Frontend 管理子进程生命周期 — 与"纯 UI"定位矛盾，崩溃恢复难做
- ❌ Engine 反向托管 Collector — Engine 是 TS/Bun 进程，管理 Swift 子进程不自然

---

## Decision Log

| #   | Decision                | Date       | Status      |
| --- | ----------------------- | ---------- | ----------- |
| 001 | 三端架构                | 2026-03-31 | ✅ Accepted |
| 002 | SwiftUI 前端            | 2026-03-31 | ✅ Accepted |
| 003 | TypeScript + Bun 后端   | 2026-03-31 | ✅ Accepted |
| 004 | SurrealDB 统一存储      | 2026-03-31 | ✅ Accepted |
| 005 | AI 分层策略（修订）     | 2026-03-31 | ✅ Accepted |
| 006 | HTTP REST + WebSocket   | 2026-03-31 | ✅ Accepted |
| 007 | WebP 截图格式           | 2026-03-31 | ✅ Accepted |
| 008 | Hono HTTP 框架          | 2026-03-31 | ✅ Accepted |
| 009 | Biome Linter            | 2026-03-31 | ✅ Accepted |
| 010 | Turborepo Monorepo      | 2026-03-31 | ✅ Accepted |
| 011 | 端口号 21890            | 2026-03-31 | ✅ Accepted |
| 012 | 截图变化检测策略        | 2026-03-31 | ✅ Accepted |
| 013 | Collector vs Agent 命名 | 2026-03-31 | ✅ Accepted |
| 014 | MCP Server 设计策略     | 2026-03-31 | ✅ Accepted |
| 015 | Swift ↔ TS 类型同步     | 2026-04-01 | ✅ Accepted |
| 016 | Vercel AI SDK           | 2026-04-01 | ✅ Accepted |
| 017 | OCR 归属 Collector 端   | 2026-04-01 | ✅ Accepted |
| 018 | 进程生命周期托管模型    | 2026-04-01 | ✅ Accepted |
