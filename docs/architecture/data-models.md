# Recaply Sense — Data Models

> Version: 0.1.0 | Last Updated: 2026-04-01

## SurrealDB Data Model

SurrealDB 使用 record-based 模型，支持文档、图关系和向量。
以下定义了系统的核心数据结构。

---

## 1. Core Tables (Documents)

### `screenshot` — 截图记录

```surql
DEFINE TABLE screenshot SCHEMAFULL;

DEFINE FIELD path           ON screenshot TYPE string;         -- 文件路径
DEFINE FIELD timestamp      ON screenshot TYPE datetime;       -- 截图时间
DEFINE FIELD app_name       ON screenshot TYPE string;         -- 应用名
DEFINE FIELD bundle_id      ON screenshot TYPE string;         -- 应用 Bundle ID
DEFINE FIELD window_title   ON screenshot TYPE string;         -- 窗口标题
DEFINE FIELD display_id     ON screenshot TYPE int;            -- 显示器 ID
DEFINE FIELD ocr_text       ON screenshot TYPE option<string>; -- OCR 提取的文本
DEFINE FIELD is_active      ON screenshot TYPE bool;           -- 是否是活跃窗口
DEFINE FIELD diff_ratio     ON screenshot TYPE float;          -- 与上一帧的差异比
DEFINE FIELD resolution     ON screenshot TYPE string;         -- 分辨率
DEFINE FIELD file_size      ON screenshot TYPE int;            -- 文件大小 (bytes)
DEFINE FIELD status         ON screenshot TYPE string DEFAULT 'queued';
    -- 'queued' | 'processing' | 'done' | 'dead_letter'
DEFINE FIELD retry_count    ON screenshot TYPE int DEFAULT 0;  -- 处理重试次数
DEFINE FIELD last_error     ON screenshot TYPE option<string>; -- 最后一次处理错误信息
DEFINE FIELD ocr_truncated  ON screenshot TYPE bool DEFAULT false; -- OCR 文本是否经过截断
DEFINE FIELD purged         ON screenshot TYPE bool DEFAULT false; -- 截图文件是否已清理（保留元数据）
DEFINE FIELD embedding      ON screenshot TYPE option<array<float>>; -- 向量嵌入 (BGE-M3, 1024维)
DEFINE FIELD timezone        ON screenshot TYPE string;         -- 采集时的时区 (e.g. "Asia/Shanghai")
DEFINE FIELD local_date      ON screenshot TYPE string;         -- 本地日期 (e.g. "2026-03-31")
DEFINE FIELD local_hour      ON screenshot TYPE int;            -- 本地小时 (0-23)
DEFINE FIELD capture_id      ON screenshot TYPE string;         -- 幂等 ID: sha256(path+timestamp+file_size+machine_id)
DEFINE FIELD created_at     ON screenshot TYPE datetime DEFAULT time::now();

-- 索引
DEFINE INDEX idx_screenshot_timestamp ON screenshot FIELDS timestamp;
DEFINE INDEX idx_screenshot_app       ON screenshot FIELDS app_name;
DEFINE INDEX idx_screenshot_status    ON screenshot FIELDS status;
DEFINE INDEX idx_screenshot_bundle    ON screenshot FIELDS bundle_id;
DEFINE INDEX idx_screenshot_capture   ON screenshot FIELDS capture_id UNIQUE; -- 幂等去重
DEFINE INDEX idx_screenshot_local     ON screenshot FIELDS local_date, local_hour; -- 按本地时间聚合

-- 全文搜索索引
-- 注意：SurrealDB 内建 tokenizer 对中文分词不友好（无中文分词器）
-- 英文使用 snowball(english) 词干化；中文依赖 Ingestion Pipeline 预分词后存入 ocr_text_tokenized
-- 中文语义检索主要依赖 Embedding 向量搜索（BGE-M3）
DEFINE ANALYZER ocr_analyzer TOKENIZERS class, blank FILTERS lowercase, snowball(english);
DEFINE INDEX idx_screenshot_fts ON screenshot FIELDS ocr_text
  FULLTEXT ANALYZER ocr_analyzer BM25;

-- 中文预分词文本索引（Ingestion Pipeline 预处理后写入，用空格分隔的中文分词结果）
DEFINE FIELD ocr_text_tokenized ON screenshot TYPE option<string>;
DEFINE ANALYZER cjk_analyzer TOKENIZERS blank FILTERS lowercase;
DEFINE INDEX idx_screenshot_fts_cjk ON screenshot FIELDS ocr_text_tokenized
  FULLTEXT ANALYZER cjk_analyzer BM25;

-- 向量索引 (HNSW)
DEFINE INDEX idx_screenshot_vec ON screenshot FIELDS embedding
  HNSW DIMENSION 1024 DIST COSINE;  -- 1024 = BGE-M3 维度
```

### `entity` — 实体 (人/应用/URL/话题等)

```surql
DEFINE TABLE entity SCHEMAFULL;

DEFINE FIELD type       ON entity TYPE string;        -- 'person', 'app', 'url', 'topic', 'project', 'file'
DEFINE FIELD name       ON entity TYPE string;        -- 实体名称
DEFINE FIELD aliases    ON entity TYPE option<array<string>>; -- 别名列表
DEFINE FIELD metadata   ON entity TYPE option<object>;  -- 附加元数据
DEFINE FIELD first_seen ON entity TYPE datetime;       -- 首次出现时间
DEFINE FIELD last_seen  ON entity TYPE datetime;       -- 最后出现时间
DEFINE FIELD frequency  ON entity TYPE int DEFAULT 0;  -- 出现频率
DEFINE FIELD embedding  ON entity TYPE option<array<float>>; -- 实体向量
DEFINE FIELD created_at ON entity TYPE datetime DEFAULT time::now();

DEFINE INDEX idx_entity_type      ON entity FIELDS type;
DEFINE INDEX idx_entity_name      ON entity FIELDS name;
DEFINE INDEX idx_entity_type_name ON entity FIELDS type, name UNIQUE;
DEFINE INDEX idx_entity_freq      ON entity FIELDS frequency;

DEFINE INDEX idx_entity_vec ON entity FIELDS embedding
  HNSW DIMENSION 1024 DIST COSINE;
```

### `chat_session` — AI 对话会话

```surql
DEFINE TABLE chat_session SCHEMAFULL;

DEFINE FIELD title      ON chat_session TYPE option<string>;
DEFINE FIELD created_at ON chat_session TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at ON chat_session TYPE datetime DEFAULT time::now();
```

### `chat_message` — 对话消息

```surql
DEFINE TABLE chat_message SCHEMAFULL;

DEFINE FIELD session     ON chat_message TYPE record<chat_session>;
DEFINE FIELD role        ON chat_message TYPE string;     -- 'user', 'assistant', 'system'
DEFINE FIELD content     ON chat_message TYPE string;
DEFINE FIELD metadata    ON chat_message TYPE option<object>; -- 引用的截图、搜索结果等
DEFINE FIELD created_at  ON chat_message TYPE datetime DEFAULT time::now();

DEFINE INDEX idx_msg_session ON chat_message FIELDS session;
```

### `settings` — 用户设置

```surql
DEFINE TABLE settings SCHEMAFULL;

DEFINE FIELD key   ON settings TYPE string;
DEFINE FIELD value ON settings TYPE any;

DEFINE INDEX idx_settings_key ON settings FIELDS key UNIQUE;
```

### `migration_history` — 数据库迁移记录

```surql
DEFINE TABLE migration_history SCHEMAFULL;

DEFINE FIELD version     ON migration_history TYPE int;
DEFINE FIELD name        ON migration_history TYPE string;
DEFINE FIELD applied_at  ON migration_history TYPE datetime DEFAULT time::now();
DEFINE FIELD duration_ms ON migration_history TYPE int;

DEFINE INDEX idx_mh_version ON migration_history FIELDS version UNIQUE;
```

### `entity_merge_candidate` — 实体合并候选

```surql
DEFINE TABLE entity_merge_candidate SCHEMAFULL;

DEFINE FIELD entity_a    ON entity_merge_candidate TYPE record<entity>;
DEFINE FIELD entity_b    ON entity_merge_candidate TYPE record<entity>;
DEFINE FIELD similarity  ON entity_merge_candidate TYPE float;     -- 相似度得分
DEFINE FIELD match_type  ON entity_merge_candidate TYPE string;    -- 'name' | 'alias' | 'vector' | 'mixed'
DEFINE FIELD status      ON entity_merge_candidate TYPE string DEFAULT 'pending';
    -- 'pending' | 'merged' | 'rejected'
DEFINE FIELD created_at  ON entity_merge_candidate TYPE datetime DEFAULT time::now();

DEFINE INDEX idx_emc_status ON entity_merge_candidate FIELDS status;
```

### `activity_segment` — 活动片段（Vision LLM 生成, TDR-019）

```surql
DEFINE TABLE activity_segment SCHEMAFULL;

DEFINE FIELD app_name ON activity_segment TYPE string;
DEFINE FIELD bundle_id ON activity_segment TYPE string;
DEFINE FIELD display_id ON activity_segment TYPE int;
DEFINE FIELD session_start ON activity_segment TYPE datetime;
DEFINE FIELD session_end ON activity_segment TYPE datetime;
DEFINE FIELD duration_seconds ON activity_segment TYPE int;

-- Vision LLM 生成的结构化描述
DEFINE FIELD activity ON activity_segment TYPE string;        -- "在 Slack #general 和张三讨论项目进度"
DEFINE FIELD scene_type ON activity_segment TYPE string;      -- coding|chatting|browsing|designing|meeting|reading|other
DEFINE FIELD summary ON activity_segment TYPE string;         -- 一段话摘要
DEFINE FIELD visual_elements ON activity_segment TYPE array;  -- ["代码编辑器", "聊天消息列表"]
DEFINE FIELD key_entities ON activity_segment TYPE array;     -- [{name:"张三", type:"person"}, ...]

-- 中文预分词字段（Ingestion Pipeline 预处理后写入，与 screenshot 相同策略）
DEFINE FIELD activity_tokenized ON activity_segment TYPE option<string>;
DEFINE FIELD summary_tokenized  ON activity_segment TYPE option<string>;

-- 关联的截图 ID（代表帧）
DEFINE FIELD screenshot_ids ON activity_segment TYPE array;   -- ["screenshot:abc123", ...]
DEFINE FIELD frame_count ON activity_segment TYPE int;        -- 原始帧数（去重前）
DEFINE FIELD selected_frame_count ON activity_segment TYPE int; -- 代表帧数（去重后）

-- 元数据
DEFINE FIELD embedding ON activity_segment TYPE array<float>; -- summary 的 BGE-M3 向量 (1024维)
DEFINE FIELD llm_model ON activity_segment TYPE string;       -- 使用的 Vision LLM 模型
DEFINE FIELD llm_tokens_in ON activity_segment TYPE int;      -- input token 数
DEFINE FIELD llm_tokens_out ON activity_segment TYPE int;     -- output token 数
DEFINE FIELD processed_at ON activity_segment TYPE datetime DEFAULT time::now();

-- 索引
DEFINE INDEX idx_segment_time ON activity_segment FIELDS session_start;
DEFINE INDEX idx_segment_app ON activity_segment FIELDS bundle_id, session_start;
DEFINE INDEX idx_segment_scene ON activity_segment FIELDS scene_type;
DEFINE INDEX idx_segment_embedding ON activity_segment FIELDS embedding HNSW DIMENSION 1024 DIST COSINE;

-- 全文搜索索引（英文 + 中文预分词）
DEFINE INDEX idx_segment_activity_fts ON activity_segment FIELDS activity
  FULLTEXT ANALYZER ocr_analyzer BM25;
DEFINE INDEX idx_segment_summary_fts ON activity_segment FIELDS summary
  FULLTEXT ANALYZER ocr_analyzer BM25;
DEFINE INDEX idx_segment_activity_cjk ON activity_segment FIELDS activity_tokenized
  FULLTEXT ANALYZER cjk_analyzer BM25;
DEFINE INDEX idx_segment_summary_cjk ON activity_segment FIELDS summary_tokenized
  FULLTEXT ANALYZER cjk_analyzer BM25;
```

---

## 2. Graph Relations (Edges)

SurrealDB 使用 `RELATE` 语法创建图关系。

### `appeared_in` — 实体出现在截图中

```surql
DEFINE TABLE appeared_in SCHEMAFULL TYPE RELATION IN entity OUT screenshot;

DEFINE FIELD timestamp  ON appeared_in TYPE datetime;
DEFINE FIELD confidence ON appeared_in TYPE float;     -- NER 置信度
DEFINE FIELD context    ON appeared_in TYPE option<string>; -- 出现时的上下文文本片段
DEFINE FIELD created_at ON appeared_in TYPE datetime DEFAULT time::now();

DEFINE INDEX idx_appeared_time ON appeared_in FIELDS timestamp;
```

### `related_to` — 实体之间的关联

```surql
DEFINE TABLE related_to SCHEMAFULL TYPE RELATION IN entity OUT entity;

DEFINE FIELD relation_type ON related_to TYPE string;
    -- 'co_appeared'    : 同时出现在同一截图
    -- 'mentioned'      : A 文本中提到了 B
    -- 'used_with'      : 应用 A 和 B 同时使用
    -- 'belongs_to'     : 人属于项目/组织
    -- 'derived_from'   : 话题 A 派生自话题 B

DEFINE FIELD weight     ON related_to TYPE float DEFAULT 1.0;  -- 关系强度
DEFINE FIELD first_seen ON related_to TYPE datetime;
DEFINE FIELD last_seen  ON related_to TYPE datetime;
DEFINE FIELD count      ON related_to TYPE int DEFAULT 1;      -- 共现次数
DEFINE FIELD created_at ON related_to TYPE datetime DEFAULT time::now();

DEFINE INDEX idx_related_type ON related_to FIELDS relation_type;
```

### ~~`follows` — 截图时序关系（已移除）~~

> **已移除 (2026-04-01)：** 截图时序关系通过 `timestamp` 索引排序实现，
> 不再为每对相邻截图单独建图边。按 2s/帧估算，10 年将产生 5000 万+ follows 边，
> 信息密度极低。API 层的 `previous_screenshot` / `next_screenshot` 通过查询实现。

---

## 3. Entity Relationship Diagram

```
                    ┌─────────────────┐
                    │   chat_session   │
                    │                 │
                    │  title          │
                    │  created_at     │
                    └────────┬────────┘
                             │ 1:N
                    ┌────────▼────────┐
                    │  chat_message   │
                    │                 │
                    │  role           │
                    │  content        │
                    │  metadata       │
                    └─────────────────┘


  ┌──────────────┐    appeared_in     ┌──────────────────┐
  │    entity     │──────────────────▶│    screenshot     │
  │              │    (N:M)          │                  │
  │  type        │                   │  path            │
  │  name        │                   │  timestamp       │
  │  aliases     │                   │  app_name        │
  │  metadata    │                   │  window_title    │
  │  frequency   │                   │  ocr_text        │
  │  embedding   │                   │  embedding       │
  └──────┬───────┘                   │  timezone        │
         │                           │  local_date      │
         │ related_to                │  capture_id      │
         │ (N:M, self-referencing)   └──────────────────┘
         ▼                           时序关系通过 timestamp
  ┌──────────────┐                   排序实现，不单独建边
  │    entity     │
  │   (other)    │
  └──────────────┘


  Entity Types:
  ┌─────────┬─────────────────────────────────────────┐
  │  type   │  examples                               │
  ├─────────┼─────────────────────────────────────────┤
  │ person  │ "张三", "John Smith", "@john_doe"        │
  │ app     │ "Slack", "VS Code", "Chrome"            │
  │ url     │ "https://github.com/...", "localhost:3000"│
  │ topic   │ "RecaplySense开发", "周报", "面试准备"    │
  │ project │ "recaply-sense", "my-startup"           │
  │ file    │ "main.swift", "architecture.md"         │
  │ email   │ "john@example.com"                      │
  └─────────┴─────────────────────────────────────────┘

  activity_segment（TDR-019, Vision LLM 生成）:
  ┌────────────────────────────────────────────────────┐
  │              activity_segment                      │
  ├────────────────────────────────────────────────────┤
  │  app_name, bundle_id                              │
  │  session_start / session_end                      │
  │  activity (LLM 描述)                              │
  │  scene_type                                       │
  │  summary, key_entities                            │
  │  screenshot_ids[] → screenshot                    │
  │  embedding (1024维)                               │
  └────────────────────────────────────────────────────┘
```

---

## 4. TypeScript Type Definitions

```typescript
// shared/src/types/screenshot.ts

export interface Screenshot {
  id: string; // SurrealDB record ID: "screenshot:xxx"
  path: string;
  timestamp: Date;
  app_name: string;
  bundle_id: string;
  window_title: string;
  display_id: number;
  ocr_text: string | null;
  ocr_text_tokenized: string | null; // 中文预分词文本（空格分隔）
  is_active: boolean;
  diff_ratio: number;
  resolution: string;
  file_size: number;
  status: "queued" | "processing" | "done" | "dead_letter";
  retry_count: number;
  last_error: string | null;
  ocr_truncated: boolean;
  purged: boolean;
  embedding: number[] | null; // BGE-M3, 1024 维
  timezone: string; // e.g. "Asia/Shanghai"
  local_date: string; // e.g. "2026-03-31"
  local_hour: number; // 0-23
  capture_id: string; // 幂等 ID: sha256(path + timestamp + file_size + machine_id)
  created_at: Date;
}

// shared/src/types/entity.ts

export type EntityType =
  | "person"
  | "app"
  | "url"
  | "topic"
  | "project"
  | "file"
  | "email";

export interface Entity {
  id: string; // "entity:xxx"
  type: EntityType;
  name: string;
  aliases: string[];
  metadata: Record<string, unknown> | null;
  first_seen: Date;
  last_seen: Date;
  frequency: number;
  embedding: number[] | null;
  created_at: Date;
}

// shared/src/types/relationship.ts

export type RelationType =
  | "co_appeared"
  | "mentioned"
  | "used_with"
  | "belongs_to"
  | "derived_from";

export interface Relationship {
  id: string;
  in: string; // entity ID
  out: string; // entity ID
  relation_type: RelationType;
  weight: number;
  first_seen: Date;
  last_seen: Date;
  count: number;
}

// shared/src/types/chat.ts

export interface ChatSession {
  id: string;
  title: string | null;
  created_at: Date;
  updated_at: Date;
}

export type MessageRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  session: string; // chat_session record ID
  role: MessageRole;
  content: string;
  metadata: {
    referenced_screenshots?: string[];
    search_query?: string;
    entities_mentioned?: string[];
  } | null;
  created_at: Date;
}

// shared/src/types/activity.ts (TDR-019)

export type SceneType =
  | "coding"
  | "chatting"
  | "browsing"
  | "designing"
  | "meeting"
  | "reading"
  | "writing"
  | "terminal"
  | "other";

export interface ActivitySegment {
  id: string;
  app_name: string;
  bundle_id: string;
  display_id: number;
  session_start: Date;
  session_end: Date;
  duration_seconds: number;

  // Vision LLM 生成
  activity: string;                        // "在 Slack #general 和张三讨论项目进度"
  scene_type: SceneType;
  summary: string;
  visual_elements: string[];               // ["代码编辑器", "终端输出"]
  key_entities: { name: string; type: EntityType }[];

  // 中文预分词字段
  activity_tokenized: string | null;
  summary_tokenized: string | null;

  // 关联截图
  screenshot_ids: string[];
  frame_count: number;                     // 原始帧数
  selected_frame_count: number;            // 去重后代表帧数

  // 元数据
  embedding?: number[];                    // summary 的 BGE-M3 向量 (1024维)
  llm_model: string;
  llm_tokens_in: number;
  llm_tokens_out: number;
  processed_at: Date;
}

// shared/src/types/search.ts

export interface SearchRequest {
  query: string;
  filters?: {
    time_range?: { start: Date; end: Date };
    apps?: string[];
    entity_types?: EntityType[];
    entities?: string[];
  };
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  screenshots: ScoredScreenshot[];
  entities: ScoredEntity[];
  total_count: number;
  strategy_used: "vector" | "fulltext" | "graph" | "hybrid";
}

export interface ScoredScreenshot extends Screenshot {
  score: number;
  highlights: string[]; // 匹配的文本片段
}

export interface ScoredEntity extends Entity {
  score: number;
  related_screenshots_count: number;
}

// shared/src/types/events.ts (WebSocket)

export type WSEvent =
  | {
      type: "screenshot:new";
      data: { id: string; timestamp: Date; app_name: string };
    }
  | {
      type: "ingestion:progress";
      data: { screenshot_id: string; stage: string; progress: number };
    }
  | { type: "ingestion:complete"; data: { screenshot_id: string } }
  | { type: "search:result"; data: SearchResult }
  | {
      type: "chat:chunk";
      data: { session_id: string; content: string; done: boolean };
    }
  | {
      type: "collector:status";
      data: { status: "running" | "paused" | "stopped" };
    }
  | { type: "error"; data: { code: string; message: string } };
```

---

## 5. Query Examples

### 基础查询

```surql
-- 按时间范围获取截图
SELECT * FROM screenshot
WHERE timestamp >= '2026-03-24T00:00:00Z'
  AND timestamp <= '2026-03-31T23:59:59Z'
ORDER BY timestamp DESC
LIMIT 50;

-- 按应用查询
SELECT * FROM screenshot
WHERE app_name = 'Slack'
  AND timestamp >= '2026-03-30T00:00:00Z'
ORDER BY timestamp DESC;

-- 全文搜索 OCR 文本
SELECT *, search::score(1) AS score FROM screenshot
WHERE ocr_text @1@ 'project deadline'
ORDER BY score DESC
LIMIT 20;

-- 向量语义搜索
LET $query_vec = <从 embedding 模型获取>;
SELECT *, vector::similarity::cosine(embedding, $query_vec) AS score
FROM screenshot
WHERE embedding <|10,1024|> $query_vec
ORDER BY score DESC
LIMIT 20;
```

### 图查询

```surql
-- 找到 "张三" 出现过的所有截图
SELECT ->appeared_in->screenshot FROM entity
WHERE type = 'person' AND name = '张三';

-- 找到与 "张三" 相关的所有实体
SELECT ->related_to->entity FROM entity
WHERE type = 'person' AND name = '张三';

-- 找到 "张三" 和 "Slack" 共同出现的截图
SELECT id, timestamp, ocr_text FROM screenshot
WHERE id IN (
  SELECT ->appeared_in->screenshot.id FROM entity WHERE name = '张三'
) AND id IN (
  SELECT ->appeared_in->screenshot.id FROM entity WHERE name = 'Slack'
)
ORDER BY timestamp DESC;

-- 两跳查询：张三用过的应用中，还有谁也在用
SELECT out.name AS person, <-appeared_in<-entity[WHERE type = 'app'].name AS app
FROM appeared_in
WHERE in = (SELECT id FROM entity WHERE name = '张三')
  AND out.app_name IN (
    SELECT DISTINCT app_name FROM screenshot
    WHERE id IN (SELECT ->appeared_in->screenshot.id FROM entity WHERE name = '张三')
  );
```

### 复合智能查询（由 Agent 工具调用生成）

```surql
-- 用户问："上周我跟张三在 Slack 上讨论那个项目时提到的链接"
-- AI 分解为多步查询：

-- Step 1: 时间范围 + 应用过滤
LET $screenshots = (
  SELECT id FROM screenshot
  WHERE timestamp >= '2026-03-24T00:00:00Z'
    AND app_name = 'Slack'
);

-- Step 2: 包含张三的截图
LET $zhangsan_shots = (
  SELECT ->appeared_in->screenshot.id AS id FROM entity
  WHERE name = '张三'
);

-- Step 3: 交集
LET $filtered = array::intersect($screenshots.id, $zhangsan_shots.id);

-- Step 4: 在这些截图中找 URL 实体
SELECT entity.name AS url, screenshot.timestamp, screenshot.ocr_text
FROM appeared_in
WHERE out IN $filtered
  AND in.type = 'url'
ORDER BY screenshot.timestamp DESC;
```
