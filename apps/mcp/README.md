# RecapSense MCP Server（本机工具入口）

这是一个最小可用的 MCP server（stdio 传输），用于把 RecapSense 的只读能力暴露给 MCP 客户端（Claude Desktop 等）。

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

```bash
node src/server.mjs
```
