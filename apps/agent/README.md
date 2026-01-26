# RecapSense Agent（本地服务）

本地 Node.js 服务，负责：

- SQLite 存储（长期 `chunks`，短期 `frames`）
- chunks 搜索（优先使用 SQLite FTS；在缺少 FTS 模块时自动降级）
- 提供采集端写入的 ingestion 接口
-（后续）embeddings + 混合检索 + 总结

## 全文索引（FTS）兼容性说明

你可能会在某些环境里遇到类似错误：

`no such module: fts5`

原因是：当前 Node 的 `node:sqlite` 绑定所使用的 SQLite 构建，可能没有编译进 `fts5`（甚至 `fts4`）。

RecapSense 的策略是：

- 启动时**尽力而为**创建 `chunks_fts`（优先 `fts5`，其次 `fts4`）
- 如果确实缺少 FTS 模块，则搜索会自动降级为 `LIKE`（能跑通闭环，但长远性能会差）

你可以通过设置 `RECAPSENSE_DISABLE_FTS=1` 强制禁用 FTS（用于排障/对比）。

## 鉴权

所有 `/v1/*` 接口都需要：

```
Authorization: Bearer <token>
```

token 默认存放在：

- `${RECAPSENSE_DATA_DIR}/secret/token`（不设置时默认是 `./.recapsense/secret/token`）

## 接口（MVP）

- `GET /health`（无需鉴权）：健康检查
- `GET /v1/settings`：获取设置（来自 SQLite `settings` 表）
- `PATCH /v1/settings`：更新设置（写入 SQLite `settings` 表）
- `GET /v1/search?q=...&limit=...&app=...&scope=...`：搜索 chunks（FTS 优先）；`q` 为空则返回最近 chunks
  - `app`（可选）：只返回 `app` 匹配的 chunks（大小写不敏感，按值精确匹配）
  - `scope`（可选）：搜索范围（默认 `all`）
    - `all`：正文 + `app` + `window_title`（与旧行为一致）
    - `meta`：只在 `app/window_title` 中匹配（适合“按应用/窗口标题找”，减少噪声）
    - `text`：只在正文 `text` 中匹配
- `GET /v1/chunks/:id`：按 id 获取 chunk
- `GET /v1/summaries/daily?date=YYYY-MM-DD`：获取（并尽力自动生成）日总结
- `GET /v1/timeline/daily?date=YYYY-MM-DD`：获取当天时间轴（基于 frames 推导）
  - 输出：`apps`（按用时排序）+ `spans`（时间轴片段）+ `sessions`（按 app 合并的会话，默认 5 分钟内来回切换会合并）
- `POST /v1/ingest/frame`：写入截图 OCR 帧
  - body: `{ ts, app, windowTitle, ocrText, phash?, screenshotPath?, thumbnailPath? }`
- `POST /v1/ingest/chunk`：直接写入/更新 chunk（测试用）
  - body: `{ id?, startTs, endTs, app?, windowTitle?, text }`
- `GET /v1/backup/db`：下载数据库一致快照（单文件 `.db`），用于备份/换电脑
  - 说明：
    - 返回的是“可直接复制/替换”的 SQLite 数据库文件（不需要额外带上 `-wal/-shm`）
    - 如果你希望保留截图/缩略图，请同时备份 `media/` 目录（体积可能较大）
- `POST /v1/maintenance/cleanup`：清理过期“热证据”（media 文件）
  - 说明：
    - 只清理 **已经被压实进 chunks 的 frames**（`chunk_id IS NOT NULL`）的截图/缩略图文件，避免误删未压实证据
    - frames 的原始文本（`ocr_text`）**永久保留**（可反悔）；清理时会清空 `screenshot_path/thumbnail_path`，避免悬挂引用
  - body（可选）：`{ retentionDays?: number, maxFramesPerRun?: number }`
    - retentionDays 默认取 `settings.agent.evidenceRetentionDays`
  - response：`{ result: { clearedFrames, deletedFiles, cutoffTs, ... } }`
- `GET /v1/maintenance/media-stats`：获取 media（热证据目录）占用情况
  - response：`{ stats: { totalBytes, fileCount, thresholdBytes, overThreshold, scannedAt } }`

## 预留接口（未实现，仅做协议占位）

下面这些接口目前**还没有实现**，目的是先把“未来扩展方向”在协议层固定一个大致形态，避免后续推倒重来。

### 视觉增强（LLM Vision Enrichment）

用途：对“少量关键帧/关键 chunk”策略性调用视觉模型（不是每 5 秒都调用），抽取有价值的信息，并将抽取结果长期保存用于检索/RAG（符合 B 模式：图片可在热窗口清理，抽取文本长期保留）。

#### 数据对象（建议）

`VisionJob`（任务，负责调度/重试/预算）：

```jsonc
{
  "id": "01J...",
  "sourceType": "frame|chunk",
  "sourceId": "123|06DY...",
  "status": "pending|processing|succeeded|failed|canceled",
  "priority": 0,
  "runAfterTs": 1730000000000,
  "attempts": 0,
  "maxAttempts": 3,
  "model": "gpt-4.1-mini",
  "promptVersion": "v1",
  "lastError": null,
  "createdAt": 1730000000000,
  "updatedAt": 1730000000000
}
```

`VisionExtraction`（产物，长期存储）：

```jsonc
{
  "id": "01J...",
  "sourceType": "frame|chunk",
  "sourceId": "123|06DY...",
  "model": "gpt-4.1-mini",
  "promptVersion": "v1",
  "text": "一句话描述 + 链接/任务等可检索文本",
  "json": {
    "caption": "…",
    "links": ["https://..."],
    "todos": ["..."],
    "entities": ["..."]
  },
  "createdAt": 1730000000000
}
```

#### 预留端点（建议）

- `POST /v1/vision/jobs`：创建一条视觉任务（通常由 Agent 内部策略触发，或由 UI 手动触发）
  - body（建议）：`{ sourceType, sourceId, priority?, runAfterTs?, model?, promptVersion? }`
  - response（建议）：`{ job: VisionJob }`
- `GET /v1/vision/jobs?status=&limit=&cursor=`：列出任务（调试/可观测）
  - response（建议）：`{ jobs: VisionJob[], nextCursor? }`
- `POST /v1/vision/jobs/:id/cancel`：取消任务
  - response（建议）：`{ ok: true }`
- `GET /v1/vision/extractions?sourceType=&sourceId=&limit=&cursor=`：按来源查询抽取结果
  - response（建议）：`{ extractions: VisionExtraction[], nextCursor? }`
- `GET /v1/vision/extractions/:id`：获取单条抽取结果
  - response（建议）：`{ extraction: VisionExtraction }`

#### 备注

- `sourceId`：`frame` 的 `sourceId` 建议使用 `frames.id`（数字也可，但建议在 API 层当字符串处理，便于统一）；`chunk` 的 `sourceId` 为 chunk 的 ulid。
- 抽取结果应长期保留；模型升级时允许并行保存多个版本（通过 `model`/`promptVersion` 区分），并可按需重建。

## 配置（环境变量，MVP）

- `RECAPSENSE_AGENT_SOCKET`：启用 Unix Domain Socket（UDS）监听
  - 取值：
    - `1`/`true`：使用默认路径 `${RECAPSENSE_DATA_DIR}/run/agent.sock`
    - 绝对路径：使用该路径
    - 相对路径：相对 `${RECAPSENSE_DATA_DIR}`（便于迁移）
  - 说明：默认仍会监听 `127.0.0.1:4832`，用于兼容 collector（Swift 的 URLSession 不支持 UDS）
- `RECAPSENSE_AGENT_DISABLE_TCP=1`：只启用 UDS，不监听 TCP 端口（用于受限环境/更严格的本机隔离）
- `RECAPSENSE_DISABLE_FTS=1`：强制禁用 FTS（排障用；会降级为 LIKE 搜索）

## 设置（SQLite settings 表）

开发期我们把“用户设置”统一存放在数据库的 `settings` 表里，并提供 `/v1/settings` 读写接口。

当前已使用/约定的 key（后续会扩展）：

- `collector.intervalSeconds`：采集间隔秒数（默认 `5`）
- `collector.dedupeThreshold`：dHash 去重阈值（默认 `2`）
- `collector.thumbnailEnabled`：是否写入缩略图（默认 `true`）
- `collector.thumbnailMaxWidth`：缩略图最大宽度（默认 `720`）
- `agent.evidenceRetentionDays`：热证据（截图/缩略图文件）保留天数（默认 `365`）；frames 文本永久保留
- `agent.evidenceCleanupIntervalMinutes`：清理任务间隔分钟数（默认 `60`）
- `agent.mediaWarnThresholdBytes`：media 占用提醒阈值（字节，默认 `10GB`；只提醒不自动清理）
