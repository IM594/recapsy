# Recaply Sense — Tech Decisions Record

> Version: 0.1.0 | Last Updated: 2026-03-31

本文档记录了项目中所有重要的技术决策，包含决策原因和被否决的备选方案。

---

## TDR-001: 三端架构（Frontend + Agent + Engine）

**决策：** 系统分为前端(UI)、采集端(Agent)、后端(Engine) 三个独立模块。

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

## TDR-005: AI 混合模式（本地优先 + 云端可选）

**决策：** 默认使用本地 AI 模型，可选切换到云端 API。

**组件分配：**
| 功能 | 默认（本地） | 可选（云端） |
|------|-------------|-------------|
| OCR | Apple Vision | - |
| Embedding | BGE-small (ONNX) | OpenAI text-embedding |
| NER (实体提取) | 本地规则 + 小模型 | GPT-4o |
| LLM (对话/查询) | Ollama (llama3/qwen) | OpenAI / Claude |

**原因：**

- 日常运行零成本、零网络依赖
- 隐私敏感数据（屏幕截图）不出本机
- 需要强推理能力时可切换云端
- 用户自主选择隐私/能力的平衡点

**否决方案：**

- ❌ 纯云端 — 隐私风险，持续 API 费用
- ❌ 纯本地 — LLM 能力受限，复杂查询效果差

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
- Swift 项目（apps/desktop, apps/agent）独立用 Xcode/SPM 构建

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

## Decision Log

| #   | Decision              | Date       | Status      |
| --- | --------------------- | ---------- | ----------- |
| 001 | 三端架构              | 2026-03-31 | ✅ Accepted |
| 002 | SwiftUI 前端          | 2026-03-31 | ✅ Accepted |
| 003 | TypeScript + Bun 后端 | 2026-03-31 | ✅ Accepted |
| 004 | SurrealDB 统一存储    | 2026-03-31 | ✅ Accepted |
| 005 | AI 混合模式           | 2026-03-31 | ✅ Accepted |
| 006 | HTTP REST + WebSocket | 2026-03-31 | ✅ Accepted |
| 007 | WebP 截图格式         | 2026-03-31 | ✅ Accepted |
| 008 | Hono HTTP 框架        | 2026-03-31 | ✅ Accepted |
| 009 | Biome Linter          | 2026-03-31 | ✅ Accepted |
| 010 | Turborepo Monorepo    | 2026-03-31 | ✅ Accepted |
| 011 | 端口号 21890          | 2026-03-31 | ✅ Accepted |
| 012 | 截图变化检测策略      | 2026-03-31 | ✅ Accepted |
| 013 | Collector vs Agent 命名 | 2026-03-31 | ✅ Accepted |
| 014 | MCP Server 设计策略   | 2026-03-31 | ✅ Accepted |
