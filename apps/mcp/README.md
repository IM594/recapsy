# RecapSense MCP Server（本机工具入口）

这是一个最小可用的 MCP server，用于把 RecapSense 的只读能力暴露给 MCP 客户端（Claude Desktop 等）。

支持两种传输方式：

- **stdio（默认）**：适合 Claude Desktop 这类“进程型”集成
- **SSE（HTTP）**：适合本机 HTTP 方式集成（例如自建 MCP 客户端/代理）

## 工具（MVP）

- `recapsense_search`：在本地记忆 chunks 里做关键词搜索
- `recapsense_get_chunk`：按 chunk id 获取完整内容（全文 + app/window/title）
- `recapsense_get_daily_summary`：按日期获取日总结（当天无数据则为空）

## 依赖

- 需要先在本机运行 RecapSense Agent（默认 `http://127.0.0.1:4832`）
- MCP server 需要拿到同一个 API token：
  - 方式 1：提供 `RECAPSENSE_API_TOKEN`
  - 方式 2：提供 `RECAPSENSE_DATA_DIR`，并确保目录里有 `secret/token`
-（可选）如果 Agent 启用了 Unix Domain Socket（UDS），MCP 会优先使用它：
  - `RECAPSENSE_AGENT_SOCKET=1`（默认 `${RECAPSENSE_DATA_DIR}/run/agent.sock`）
  - 或 `RECAPSENSE_AGENT_SOCKET=/absolute/path/to/agent.sock`

## 运行

### stdio（默认）

```bash
node src/server.mjs
```

### SSE（HTTP，本机）

默认监听：`http://127.0.0.1:4833`

```bash
node src/server-sse.mjs
```

可配置环境变量：

- `RECAPSENSE_MCP_HOST`（默认 `127.0.0.1`）
- `RECAPSENSE_MCP_PORT`（默认 `4833`）
- `RECAPSENSE_MCP_SSE_KEEPALIVE_SECONDS`（默认 `15`，仅用于避免连接空闲超时）

SSE endpoint：

- `GET /sse`：建立 SSE 连接（需要 token）
- `POST /message?sessionId=...`：发送 JSON-RPC 消息（**推荐**带 token；但多数 MCP 客户端会在建立 SSE 后仅携带 `sessionId`，此时服务端也会接受）

说明：SSE 连接建立后，服务端会先发一个 `event: endpoint`，告诉客户端应该往哪个 `/message` endpoint 发消息。

## Cherry Studio（SSE）接入

Cherry Studio 支持用 SSE 的方式接入 MCP。RecapSense 的推荐配置是：

- URL：`http://127.0.0.1:4833/sse?token=YOUR_TOKEN`

其中 `YOUR_TOKEN` 可以从以下位置获取（任选其一）：

- RecapSense 数据目录：`${RECAPSENSE_DATA_DIR}/secret/token`
- 默认数据目录：`<repoRoot>/.recapsense/secret/token`（开发态）

常见报错排查：

- `Error invoking remote method 'mcp:list-tools': ServerError`
  - 通常意味着 MCP 客户端无法调用 `tools/list`。
  - 优先检查：URL 是否是 `/sse?token=...`（不是 `/health`、也不是 `/message`）。
  - 再检查：RecapSense 是否正在运行（确保 `127.0.0.1:4833` 端口已监听）。
  - 最后查看：`.recapsense/logs/mcp-sse.log` 是否有 `unauthorized /sse` 或 `unknown session` 的日志。
