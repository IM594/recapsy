# RecapSense（MVP 骨架）

目标：做一个本地、全天候运行的「记忆」管线（屏幕 → OCR → 长期 chunks → 搜索/RAG），同时提供本地 HTTP API 和 MCP server（stdio）供外部工具/LLM 调用。

当前仓库是一个 MVP 骨架，重点在：

- `apps/agent`：本地 Node.js Agent（HTTP + SQLite/FTS）  
- `apps/mcp`：MCP server（stdio），提供只读工具（先从 `recapsense_search` 开始）  
- `apps/collector-macos`：macOS 原生采集端（最小可用：截图 → dHash 去重 → Vision OCR → 写入 frames）
- `apps/app-macos`：macOS SwiftUI 菜单栏应用（骨架：开关 + 主窗口：搜索/日志）

## 兼容性提示：SQLite FTS

如果你启动 Agent 时遇到 `no such module: fts5`，说明当前环境的 SQLite 构建缺少 FTS 模块。

本项目会在启动时尽力创建全文索引（优先 fts5，其次 fts4）；如果无法创建，会自动降级为 `LIKE` 搜索（能跑通闭环，但长远性能会差）。

## 约定

- 仓库内的**注释**与**文档**统一使用中文。
- 代码标识符、API 路径、工具名保持英文（便于兼容与跨端集成）。
- 全部待办事项统一写在 `TODO.md`，并要求每次提交前维护更新。
- 任何改动前，需要**思考代码一致性**。

## 快速开始（开发环境）

### 最简单：一条命令启动后端（Agent + MCP SSE）

```bash
npm run dev
```

它会同时启动：

- Agent（默认 `http://127.0.0.1:4832`）
- MCP（SSE，默认 `http://127.0.0.1:4833/sse`）

并且会默认开启 Agent 的 UDS（只作为“备用通道”，你不需要理解它）。

### 分步方式（更可控）

1）启动 agent：

```bash
npm run dev:agent
```

它会在 `./.recapsense/`（开发默认）创建本地数据目录，并在 `./.recapsense/secret/token` 生成访问 token。

2）插入一些 demo chunks：

```bash
npm run seed
```

3）调用本地 HTTP API：

```bash
TOKEN="$(cat .recapsense/secret/token)"
curl -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:4832/v1/search?q=demo&limit=5"
```

4）启动 MCP server（stdio）：

```bash
npm run dev:mcp
```

如果你要从 MCP 客户端连接，配置它启动这个命令即可：

```bash
node apps/mcp/src/server.mjs
```

MCP server 会读取 `./.recapsense/secret/token`，并调用本地 agent：`http://127.0.0.1:4832`。

如果你需要在更受限的环境运行（例如端口监听被限制），Agent 也支持 Unix Domain Socket（UDS），MCP 会在设置 `RECAPSENSE_AGENT_SOCKET` 后优先走 socket。

### 可选：以 SSE（HTTP）方式运行 MCP

如果你的 MCP 客户端/代理更适合走本机 HTTP（SSE），可以运行：

```bash
npm run dev:mcp:sse
```

默认监听：`http://127.0.0.1:4833/sse`

### 启动 macOS 采集端（开发）

推荐直接用一条命令（会自动编译一次，或复用已有二进制）：

```bash
npm run dev:collector -- --interval 5
```

默认会优先截取“前台窗口”区域（比全屏更干净、更适合 OCR）。如果你遇到某些窗口无法截图/黑屏等兼容性问题，可临时切换到全屏模式：

```bash
npm run dev:collector -- --capture-mode screen
```

### 启动 macOS 菜单栏应用（开发）

> 说明：当前是 SwiftPM 可执行程序形态（先跑通骨架）。后续会补齐 .app 打包/签名/notarize 等发布形态。

```bash
npm run dev:app:macos
```

#### 日志与排障

菜单栏 App 会把日志写到数据目录下的 `logs/`：

- `logs/agent.log`
- `logs/mcp-sse.log`
- `logs/collector.log`
- `logs/collector-ocr.log`（调试：OCR 全文，体量较大，超过上限会轮转为 `collector-ocr.log.1`）

主窗口「日志」页支持一键复制当前内容，便于你把问题反馈贴出来。

只采集一次（用于验证权限/OCR）：

```bash
npm run dev:collector -- --once
```

### Claude Desktop 配置示例（仅本机）

示例片段（路径请按你的机器实际情况修改）：

```jsonc
{
  "mcpServers": {
    "recapsense": {
      "command": "node",
      "args": ["apps/mcp/src/server.mjs"],
      "env": {
        "RECAPSENSE_AGENT_URL": "http://127.0.0.1:4832",
        "RECAPSENSE_DATA_DIR": "/absolute/path/to/recapsense/.recapsense"
      }
    }
  }
}
```

如果你不想传 `RECAPSENSE_DATA_DIR`，也可以直接传 `RECAPSENSE_API_TOKEN`。

## 数据目录与迁移（换电脑）

- 开发默认数据目录：`./.recapsense/`
- 推荐 macOS app 数据目录：`~/Library/Application Support/RecapSense/`

针对 “B 模式”（长期保存文本记忆；截图/音频只保留热窗口，比如 30 天），迁移很简单：

- 把 `db/` 目录下的数据库文件（例如 `db/recapsense.db`）复制到新机器的数据目录。
- `media/`（如果有）属于热证据数据，可选迁移。
- `secret/token` 属于本机访问 token，不建议跨机复用；在新机器重新生成即可。

## 数据模型（高层）

我们采用 “B 模式”留存模型：

- **长期**：只保存文本型 `chunks` 与 `daily summaries`（几十年可用）。
- **热窗口**：可选“证据”（截图/音频），只保留有限时间（默认 30 天）。
- **派生索引**：全文索引（FTS）以及后续 embeddings/向量索引都应可重建。

## 下一步里程碑

- 继续完善 macOS 采集端（多屏、ScreenCaptureKit、去重/黑名单策略等）。
- 补齐“frames → chunks”压实任务（定时、可恢复）。
- 加 embeddings + 混合检索（FTS + 向量）。
- 增加更多 MCP 工具（get_chunk / get_daily_summary / ask）。

## 预留：LLM 视觉增强

我们已经在数据库层预留了 “视觉增强（vision enrichment）” 的任务与产物结构：

- `vision_jobs`：用于任务调度/重试/预算控制（未来会在 Agent 中异步跑）
- `vision_extractions`：用于存储 LLM 视觉抽取出来的文本与结构化信息（长期保存，参与检索/RAG）

当前阶段暂不启用，先保证“截图 + OCR + 压实 + 搜索 + MCP”闭环跑通。
