# Recaply Sense — API Contracts

> Version: 0.1.0 | Last Updated: 2026-03-31

## Overview

Engine 后端通过 HTTP REST + WebSocket 对外提供服务。

```
Base URL:  http://localhost:21890/api/v1
WebSocket: ws://localhost:21890/ws
```

---

## 1. Health & Status

### `GET /api/v1/health`

检查 Engine 健康状态。Collector 和 Frontend 都使用此端点。

**Response 200:**

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime_seconds": 3600,
  "db": {
    "status": "connected",
    "mode": "embedded",
    "screenshot_count": 125000,
    "entity_count": 3400
  },
  "collector": {
    "status": "running",
    "last_screenshot_at": "2026-03-31T14:30:12.000Z"
  },
  "ai": {
    "embedding_model": "bge-m3",
    "embedding_dimensions": 1024,
    "llm_provider": "anthropic",
    "llm_model": "claude-sonnet-4-20250514",
    "llm_status": "available"
  },
  "storage": {
    "screenshots_dir_size_gb": 12.5,
    "db_size_gb": 2.1,
    "disk_free_gb": 45.2
  }
}
```

---

## 2. Ingestion (Collector → Engine)

### `POST /api/v1/ingest/screenshot`

Collector 截图后通知 Engine 处理。

**Request:**

```json
{
  "path": "/Users/xxx/Library/Application Support/RecaplySense/screenshots/2026/03/31/143012_abc123.webp",
  "timestamp": "2026-03-31T14:30:12.000Z",
  "app_name": "Slack",
  "bundle_id": "com.tinyspeck.slackmacgap",
  "window_title": "#general - Slack",
  "display_id": 1,
  "is_active": true,
  "diff_ratio": 0.35,
  "resolution": "2560x1600",
  "file_size": 204800,
  "ocr_text": "张三: 看一下这个链接 https://github.com/...",
  "capture_id": "a1b2c3d4e5f6...",
  "timezone": "Asia/Shanghai"
}
```

**Response 202 (Accepted):**

```json
{
  "screenshot_id": "screenshot:abc123",
  "status": "queued",
  "queue_position": 3
}
```

**处理流程：** Engine 异步执行 Ingestion Pipeline（中文分词 → NER → Embedding → 存储）。
OCR 已由 Collector 端完成（TDR-017），Engine 接收 `ocr_text`。`capture_id` 保证幂等性，重复提交自动去重。
Frontend 通过 WebSocket 接收进度通知。

### `POST /api/v1/ingest/batch`

批量提交截图（Collector 离线期间积攒的）。

**Request:**

```json
{
  "screenshots": [
    { "path": "...", "timestamp": "...", "app_name": "...", ... },
    { "path": "...", "timestamp": "...", "app_name": "...", ... }
  ]
}
```

**Response 202:**

```json
{
  "batch_id": "batch:xyz789",
  "count": 15,
  "status": "queued"
}
```

### `GET /api/v1/ingest/status`

查询 Ingestion Pipeline 状态。

**Response 200:**

```json
{
  "queue_length": 5,
  "processing": {
    "screenshot_id": "screenshot:abc123",
    "stage": "embedding",
    "progress": 0.6
  },
  "stats": {
    "processed_today": 12500,
    "avg_process_time_ms": 450,
    "errors_today": 2
  }
}
```

---

## 3. Search

### `POST /api/v1/search`

确定性搜索 — 按显式策略和过滤条件执行搜索，不做意图理解或查询规划。
自然语言查询请使用 `POST /api/v1/chat`（由 Agent 编排搜索）。

**Request:**

```json
{
  "query": "github 链接",
  "filters": {
    "time_range": {
      "start": "2026-03-24T00:00:00Z",
      "end": "2026-03-31T23:59:59Z"
    },
    "apps": ["Slack"],
    "entity_types": ["url"],
    "timezone": "Asia/Shanghai"
  },
  "limit": 20,
  "offset": 0,
  "strategy": "hybrid"
}
```

**`strategy` options:**

- `"vector"` — 仅向量语义搜索
- `"fulltext"` — 仅全文搜索
- `"graph"` — 仅图关系搜索
- `"hybrid"` — 向量 + 全文混合（默认）

> **activity_segment 搜索：** `hybrid` 和 `vector` 策略自动包含 `activity_segment` 的向量/全文搜索。
> `activity_segment` 的搜索结果在响应的 `activity_segments` 字段中返回。

**Response 200:**

```json
{
  "screenshots": [
    {
      "id": "screenshot:abc123",
      "path": "/Users/.../143012_abc123.webp",
      "timestamp": "2026-03-28T10:15:30.000Z",
      "app_name": "Slack",
      "window_title": "#general - Slack",
      "ocr_text": "张三: 看一下这个链接 https://github.com/...",
      "score": 0.92,
      "highlights": [
        "张三: 看一下这个链接 <mark>https://github.com/example/project</mark>"
      ]
    }
  ],
  "entities": [
    {
      "id": "entity:url_github_xxx",
      "type": "url",
      "name": "https://github.com/example/project",
      "score": 0.95,
      "related_screenshots_count": 3
    }
  ],
  "activity_segments": [
    {
      "id": "activity_segment:seg001",
      "app_name": "Slack",
      "session_start": "2026-03-28T10:00:00Z",
      "session_end": "2026-03-28T10:25:00Z",
      "activity": "在 Slack #general 和张三讨论 GitHub 项目链接",
      "scene_type": "chatting",
      "summary": "与张三讨论 RecaplySense 项目进度，交换了 GitHub PR 链接",
      "score": 0.88
    }
  ],
  "total_count": 5,
  "strategy_used": "hybrid"
}
```

### `POST /api/v1/search/suggest`

搜索建议 / 自动补全。

**Request:**

```json
{
  "query": "张",
  "limit": 5
}
```

**Response 200:**

```json
{
  "suggestions": [
    { "text": "张三", "type": "entity:person", "frequency": 150 },
    { "text": "张三的项目", "type": "topic", "frequency": 30 },
    { "text": "张三 Slack 讨论", "type": "recent_search", "frequency": 5 }
  ]
}
```

---

## 4. Timeline

### `GET /api/v1/timeline`

按时间线浏览截图。

**Query Parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `date` | string (ISO date) | today | 日期（按 timezone 计算） |
| `hour` | number (0-23) | - | 可选，指定小时 |
| `app` | string | - | 按应用过滤 |
| `timezone` | string (IANA) | `"UTC"` | 时区，用于确定 "today" 和日期边界 |
| `limit` | number | 50 | 每页数量 |
| `offset` | number | 0 | 偏移量 |
| `group_by` | string | `"minute"` | 分组粒度: `"second"`, `"minute"`, `"hour"` |

**Response 200:**

```json
{
  "date": "2026-03-31",
  "groups": [
    {
      "time": "2026-03-31T14:30:00Z",
      "screenshots": [
        {
          "id": "screenshot:abc123",
          "path": "...",
          "timestamp": "2026-03-31T14:30:12Z",
          "app_name": "Slack",
          "window_title": "#general",
          "thumbnail_path": "...",
          "ocr_text_preview": "张三: 看一下这个..."
        },
        {
          "id": "screenshot:abc124",
          "path": "...",
          "timestamp": "2026-03-31T14:30:28Z",
          "app_name": "Slack",
          "window_title": "#general",
          "thumbnail_path": "...",
          "ocr_text_preview": "好的，我看看..."
        }
      ]
    },
    {
      "time": "2026-03-31T14:31:00Z",
      "screenshots": [ ... ]
    }
  ],
  "summary": {
    "total_screenshots": 250,
    "active_hours": 8,
    "top_apps": [
      { "name": "VS Code", "count": 120, "duration_minutes": 180 },
      { "name": "Slack", "count": 80, "duration_minutes": 60 },
      { "name": "Chrome", "count": 50, "duration_minutes": 45 }
    ]
  },
  "pagination": {
    "total": 250,
    "limit": 50,
    "offset": 0,
    "has_more": true
  }
}
```

### `GET /api/v1/timeline/summary`

获取日期范围的活动摘要（日历热力图用）。

**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `start` | string (ISO date) | 开始日期 |
| `end` | string (ISO date) | 结束日期 |
| `timezone` | string (IANA) | 时区，用于确定日期边界（默认 UTC） |

**Response 200:**

```json
{
  "days": [
    { "date": "2026-03-01", "screenshot_count": 15000, "active_hours": 10 },
    { "date": "2026-03-02", "screenshot_count": 8000, "active_hours": 6 },
    ...
  ]
}
```

---

## 5. Chat (AI Conversation)

### `POST /api/v1/chat/sessions`

创建新对话会话。

**Request:**

```json
{
  "title": "关于上周的工作"
}
```

**Response 201:**

```json
{
  "id": "chat_session:xyz",
  "title": "关于上周的工作",
  "created_at": "2026-03-31T14:30:00Z"
}
```

### `GET /api/v1/chat/sessions`

获取对话历史列表。

**Response 200:**

```json
{
  "sessions": [
    {
      "id": "chat_session:xyz",
      "title": "关于上周的工作",
      "last_message_preview": "你上周主要在做...",
      "message_count": 6,
      "created_at": "2026-03-31T14:30:00Z",
      "updated_at": "2026-03-31T14:35:00Z"
    }
  ]
}
```

### `POST /api/v1/chat/sessions/:session_id/messages`

发送消息并获取 AI 回复。

**Request:**

```json
{
  "content": "我上周都做了些什么？"
}
```

**Response 200 (非流式):**

> **流式 vs 非流式选择策略：**
> - **推荐路径：** Frontend 使用 WebSocket `chat:send` 获取流式回复（实时打字效果）
> - **HTTP POST 非流式路径** 作为降级方案：WS 连接不可用时使用，等待完整回复后一次性返回
> - 不提供 HTTP SSE 方案以避免三套流式协议的维护成本

```json
{
  "user_message": {
    "id": "chat_message:m1",
    "role": "user",
    "content": "我上周都做了些什么？",
    "created_at": "2026-03-31T14:30:00Z"
  },
  "assistant_message": {
    "id": "chat_message:m2",
    "role": "assistant",
    "content": "根据你的屏幕记录，上周你主要做了以下事情：\n\n1. **RecaplySense 项目开发** — 在 VS Code 中花了约 20 小时...\n2. **Slack 沟通** — 与张三讨论了项目架构...\n3. ...",
    "metadata": {
      "referenced_screenshots": ["screenshot:abc", "screenshot:def"],
      "search_query": "上周活动摘要",
      "entities_mentioned": ["entity:vscode", "entity:zhangsan"]
    },
    "created_at": "2026-03-31T14:30:05Z"
  }
}
```

### `WebSocket /ws` — 流式对话

通过 WebSocket 实现 streaming 回复：

```typescript
// Client → Server
{
  "type": "chat:send",
  "data": {
    "session_id": "chat_session:xyz",
    "content": "我上周都做了些什么？"
  }
}

// Server → Client (多个 chunk)
{ "type": "chat:chunk", "data": { "session_id": "chat_session:xyz", "content": "根据你的", "done": false } }
{ "type": "chat:chunk", "data": { "session_id": "chat_session:xyz", "content": "屏幕记录，", "done": false } }
{ "type": "chat:chunk", "data": { "session_id": "chat_session:xyz", "content": "上周你主要...", "done": false } }
{ "type": "chat:chunk", "data": { "session_id": "chat_session:xyz", "content": "", "done": true,
    "metadata": { "referenced_screenshots": ["screenshot:abc"] }
} }
```

---

## 6. Entities

### `GET /api/v1/entities`

获取实体列表。

**Query Parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | EntityType | - | 按类型过滤 |
| `q` | string | - | 按名称模糊搜索 |
| `sort` | string | `"frequency"` | 排序: `"frequency"`, `"last_seen"`, `"name"` |
| `limit` | number | 50 | |
| `offset` | number | 0 | |

**Response 200:**

```json
{
  "entities": [
    {
      "id": "entity:person_zhangsan",
      "type": "person",
      "name": "张三",
      "aliases": ["Zhang San", "@zhangsan"],
      "first_seen": "2026-01-15T09:00:00Z",
      "last_seen": "2026-03-31T14:00:00Z",
      "frequency": 1520,
      "related_entities_count": 25,
      "screenshot_count": 890
    }
  ],
  "total": 3400
}
```

### `GET /api/v1/entities/:id`

获取单个实体详情。

**Response 200:**

```json
{
  "id": "entity:person_zhangsan",
  "type": "person",
  "name": "张三",
  "aliases": ["Zhang San", "@zhangsan"],
  "metadata": { "department": "Engineering" },
  "first_seen": "2026-01-15T09:00:00Z",
  "last_seen": "2026-03-31T14:00:00Z",
  "frequency": 1520,
  "related_entities": [
    {
      "id": "entity:app_slack",
      "type": "app",
      "name": "Slack",
      "relation": "co_appeared",
      "count": 200
    },
    {
      "id": "entity:project_recaply",
      "type": "project",
      "name": "RecaplySense",
      "relation": "co_appeared",
      "count": 80
    }
  ],
  "recent_screenshots": [
    {
      "id": "screenshot:abc",
      "timestamp": "2026-03-31T14:00:00Z",
      "app_name": "Slack"
    }
  ],
  "activity_heatmap": {
    "2026-03-31": 15,
    "2026-03-30": 22,
    "2026-03-29": 8
  }
}
```

### `GET /api/v1/entities/:id/graph`

获取实体关系图（前端可视化用）。

**Query Parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `depth` | number | 1 | 遍历深度 (1-3) |
| `limit` | number | 50 | 最大节点数 |

**Response 200:**

```json
{
  "nodes": [
    {
      "id": "entity:person_zhangsan",
      "type": "person",
      "name": "张三",
      "frequency": 1520
    },
    {
      "id": "entity:app_slack",
      "type": "app",
      "name": "Slack",
      "frequency": 5000
    },
    {
      "id": "entity:project_recaply",
      "type": "project",
      "name": "RecaplySense",
      "frequency": 300
    }
  ],
  "edges": [
    {
      "source": "entity:person_zhangsan",
      "target": "entity:app_slack",
      "relation": "co_appeared",
      "weight": 200
    },
    {
      "source": "entity:person_zhangsan",
      "target": "entity:project_recaply",
      "relation": "co_appeared",
      "weight": 80
    }
  ]
}
```

---

## 7. Screenshots

### `GET /api/v1/screenshots/:id`

获取单张截图详情。

**Response 200:**

```json
{
  "id": "screenshot:abc123",
  "path": "...",
  "timestamp": "2026-03-31T14:30:12Z",
  "app_name": "Slack",
  "bundle_id": "com.tinyspeck.slackmacgap",
  "window_title": "#general - Slack",
  "ocr_text": "完整的 OCR 文本内容...",
  "entities": [
    { "id": "entity:person_zhangsan", "type": "person", "name": "张三" },
    {
      "id": "entity:url_github",
      "type": "url",
      "name": "https://github.com/..."
    }
  ],
  "previous_screenshot": "screenshot:abc122",
  "next_screenshot": "screenshot:abc124"
}
```

> **实现说明：** `previous_screenshot` 和 `next_screenshot` 不通过图边关系获取（已移除 `follows` 边），
> 而是通过 timestamp 索引查询相邻记录：
> ```surql
> -- previous
> SELECT id FROM screenshot WHERE timestamp < $current.timestamp ORDER BY timestamp DESC LIMIT 1;
> -- next
> SELECT id FROM screenshot WHERE timestamp > $current.timestamp ORDER BY timestamp ASC LIMIT 1;
> ```
```

### `GET /api/v1/screenshots/:id/image`

获取截图图片文件（代理）。

**Response 200:** Binary image/webp

### `GET /api/v1/screenshots/:id/thumbnail`

获取截图缩略图。

**Query Parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `width` | number | 320 | 缩略图宽度 |
| `quality` | number | 60 | WebP 质量 (1-100) |

**Response 200:** Binary image/webp

---

## 8. Settings

### `GET /api/v1/settings`

获取所有设置。

**Response 200:**

```json
{
  "capture": {
    "enabled": true,
    "interval_ms": 2000,
    "min_diff_ratio": 0.05,
    "excluded_apps": ["com.apple.keychainaccess", "1Password"],
    "excluded_window_titles": ["*password*", "*secret*"],
    "quiet_hours": { "start": "23:00", "end": "07:00" },
    "max_storage_gb": 500
  },
  "ai": {
    "llm_provider": "anthropic",
    "llm_model": "claude-sonnet-4-20250514",
    "ollama_url": "http://localhost:11434",
    "openai_api_key": "sk-***masked***",
    "anthropic_api_key": "sk-***masked***",
    "embedding_model": "bge-m3",
    "embedding_dimensions": 1024,
    "auto_entity_extraction": true
  },
  "privacy": {
    "blur_passwords": true,
    "encrypt_storage": false,
    "auto_delete_after_days": null
  },
  "ui": {
    "global_shortcut": "Cmd+Shift+R",
    "theme": "system",
    "language": "zh-CN"
  }
}
```

### `PATCH /api/v1/settings`

更新部分设置。

**Request:**

```json
{
  "capture": {
    "interval_ms": 5000,
    "excluded_apps": [
      "com.apple.keychainaccess",
      "1Password",
      "com.apple.Terminal"
    ]
  }
}
```

**Response 200:** 返回完整更新后的设置。

---

## 9. Collector Control

### `POST /api/v1/collector/control`

控制采集器。

**Request:**

```json
{
  "action": "pause"
}
```

**`action` options:** `"start"`, `"pause"`, `"resume"`, `"stop"`

**Response 200:**

```json
{
  "status": "paused",
  "message": "Collector paused successfully"
}
```

### `GET /api/v1/collector/config`

Collector 轮询获取配置和控制指令（每 5 秒）。

**Response 200:**

```json
{
  "control": {
    "action": "running",
    "updated_at": "2026-03-31T14:30:00Z"
  },
  "capture": {
    "interval_ms": 2000,
    "min_diff_ratio": 0.05,
    "excluded_apps": ["com.apple.keychainaccess", "1Password"],
    "excluded_window_titles": ["*password*"],
    "quality": 80
  }
}
```

### `POST /api/v1/collector/heartbeat`

Collector 上报心跳状态（随 config 轮询一起，或独立发送）。

**Request:**

```json
{
  "status": "running",
  "uptime_seconds": 86400,
  "screenshots_today": 12500,
  "last_capture_at": "2026-03-31T14:30:12.000Z"
}
```

**Response 200:**

```json
{
  "ack": true
}
```

> **Engine 心跳检测：** 15 秒未收到心跳 → 标记 Collector 异常，通过 WS 推送 `collector:status { status: "unreachable" }` 给 Frontend。

---

## 10. Statistics & Analytics

### `GET /api/v1/stats/overview`

获取总体统计。

**Response 200:**

```json
{
  "total_screenshots": 2500000,
  "total_entities": 15000,
  "total_relationships": 45000,
  "storage_used_gb": 150,
  "date_range": {
    "first": "2026-01-01T00:00:00Z",
    "last": "2026-03-31T14:30:00Z"
  },
  "today": {
    "screenshots": 12500,
    "new_entities": 15,
    "active_hours": 6.5,
    "top_apps": [
      { "name": "VS Code", "duration_minutes": 180 },
      { "name": "Chrome", "duration_minutes": 120 }
    ]
  }
}
```

### `GET /api/v1/stats/app-usage`

获取应用使用统计。

**Query Parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `start` | string (ISO date) | 7 days ago | 开始日期 |
| `end` | string (ISO date) | today | 结束日期 |
| `group_by` | string | `"day"` | `"hour"`, `"day"`, `"week"` |

**Response 200:**

```json
{
  "usage": [
    {
      "date": "2026-03-31",
      "apps": [
        {
          "name": "VS Code",
          "bundle_id": "com.microsoft.VSCode",
          "duration_minutes": 180,
          "screenshot_count": 500
        },
        {
          "name": "Chrome",
          "bundle_id": "com.google.Chrome",
          "duration_minutes": 120,
          "screenshot_count": 300
        }
      ],
      "total_active_minutes": 480
    }
  ]
}
```

---

## 11. Backup & Export

### `POST /api/v1/backup/trigger`

手动触发数据库备份。

**Response 202:**

```json
{
  "backup_id": "backup_2026-03-31_143000",
  "status": "started",
  "estimated_size_mb": 2100
}
```

### `GET /api/v1/backup/status`

查询备份状态和历史。

**Response 200:**

```json
{
  "auto_backup": {
    "enabled": true,
    "schedule": "0 3 * * *",
    "last_run": "2026-03-31T03:00:00Z",
    "last_status": "success",
    "next_run": "2026-04-01T03:00:00Z"
  },
  "backups": [
    {
      "id": "backup_2026-03-31_030000",
      "type": "auto",
      "size_mb": 2100,
      "created_at": "2026-03-31T03:00:00Z"
    }
  ],
  "retention": {
    "daily_count": 7,
    "weekly_count": 4
  }
}
```

### `POST /api/v1/export`

导出用户数据为人类可读格式。

**Request:**

```json
{
  "format": "portable",
  "include": ["screenshots", "metadata", "entities", "chat_history", "activity_segments"],
  "output_path": "/Volumes/ExternalDisk/recaply-export"
}
```

**Response 202:**

```json
{
  "export_id": "export_2026-03-31",
  "status": "started",
  "estimated_size_gb": 15.2
}
```

---

## 12. AI Usage Statistics

### `GET /api/v1/stats/ai-usage`

获取 AI 模型使用量和费用估算。

**Response 200:**

```json
{
  "today": {
    "tokens_in": 450000,
    "tokens_out": 52000,
    "estimated_cost_usd": 0.68,
    "segments_processed": 85,
    "embedding_calls": 12500
  },
  "this_month": {
    "tokens_in": 12000000,
    "tokens_out": 1500000,
    "estimated_cost_usd": 18.50,
    "segments_processed": 2400,
    "embedding_calls": 350000
  },
  "budget": {
    "daily_usd": 1.0,
    "remaining_today_usd": 0.32,
    "auto_pause_on_exceed": true
  }
}
```

---

## 13. WebSocket Events (Complete Reference)

### 连接策略

```
• Frontend 与 Engine 保持单一 WS 长连接，所有消息类型复用同一连接
• 所有 Client → Server 的请求消息必须携带 request_id（UUID v4）
• Server → Client 的响应消息回带 request_id 以关联请求（如并发多个搜索）
• 服务端主动推送（screenshot:new, ingestion:progress）不含 request_id
```

### Client → Server

```typescript
// 搜索
{ "type": "search:query", "request_id": "uuid-xxx", "data": { "query": "...", "filters": {...} } }

// 对话
{ "type": "chat:send", "request_id": "uuid-xxx", "data": { "session_id": "...", "content": "..." } }

// Collector 控制
{ "type": "collector:control", "request_id": "uuid-xxx", "data": { "action": "pause" } }

// 心跳
{ "type": "ping" }
```

### Server → Client

```typescript
// 新截图通知（服务端主动推送，无 request_id）
{ "type": "screenshot:new", "data": { "id": "...", "timestamp": "...", "app_name": "..." } }

// 摄入进度（服务端主动推送）
{ "type": "ingestion:progress", "data": { "screenshot_id": "...", "stage": "embedding", "progress": 0.6 } }
{ "type": "ingestion:complete", "data": { "screenshot_id": "..." } }

// 搜索结果（回带 request_id）
{ "type": "search:result", "request_id": "uuid-xxx", "data": { "screenshots": [...], "entities": [...], "activity_segments": [...] } }

// 对话流式回复（回带 request_id）
{ "type": "chat:chunk", "request_id": "uuid-xxx", "data": { "session_id": "...", "content": "...", "done": false } }
{ "type": "chat:chunk", "request_id": "uuid-xxx", "data": { "session_id": "...", "content": "", "done": true, "metadata": {...} } }

// Collector 状态变更（服务端主动推送）
{ "type": "collector:status", "data": { "status": "running" } }

// 错误（可能含 request_id）
{ "type": "error", "request_id": "uuid-xxx", "data": { "code": "SEARCH_FAILED", "message": "..." } }

// 心跳响应
{ "type": "pong" }
```

---

## 14. Error Response Format

所有 API 错误使用统一格式：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid time range: start must be before end",
    "details": {
      "field": "filters.time_range",
      "constraint": "start < end"
    }
  }
}
```

### Error Codes

| Code                    | HTTP Status | Description      |
| ----------------------- | ----------- | ---------------- |
| `VALIDATION_ERROR`      | 400         | 请求参数校验失败 |
| `NOT_FOUND`             | 404         | 资源不存在       |
| `COLLECTOR_UNAVAILABLE` | 503         | 采集器不可用     |
| `DB_ERROR`              | 500         | 数据库操作失败   |
| `AI_PROVIDER_ERROR`     | 502         | AI 模型调用失败  |
| `SEARCH_FAILED`         | 500         | 搜索执行失败     |
| `RATE_LIMITED`          | 429         | 请求过于频繁     |
| `STORAGE_FULL`          | 507         | 存储空间不足     |
| `INGESTION_FAILED`      | 500         | 截图处理失败     |
| `BUDGET_EXCEEDED`       | 429         | AI 用量超出预算  |
| `BACKUP_FAILED`         | 500         | 备份执行失败     |

---

## 15. API Versioning Strategy

```
当前版本: v1
路径前缀: /api/v1/

未来版本升级:
  /api/v2/ — 新版 API
  /api/v1/ — 保持向后兼容至少 6 个月

版本变更日志记录在:
  docs/api/CHANGELOG.md
```
