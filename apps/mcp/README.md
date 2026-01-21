# RecapSense MCP Server（本机工具入口）

这是一个最小可用的 MCP server，用于把 RecapSense 的只读能力暴露给 MCP 客户端（Claude Desktop 等）。

支持两种传输方式：

- **stdio（默认）**：适合 Claude Desktop 这类“进程型”集成
- **SSE（HTTP）**：适合本机 HTTP 方式集成（例如自建 MCP 客户端/代理）

## 工具（MVP）

- `recapsense_search`：在本地记忆 chunks 里做关键词搜索

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
- `POST /message?sessionId=...`：发送 JSON-RPC 消息（需要 token）

说明：SSE 连接建立后，服务端会先发一个 `event: endpoint`，告诉客户端应该往哪个 `/message` endpoint 发消息。
