# 性能基线

> 适用范围：Engine 各子模块 + Collector

## 1. 总体目标

桌面应用体验标准：用户操作即时响应，后台处理无感知。

| 体验目标       | 指标                                        |
| -------------- | ------------------------------------------- |
| 搜索"感觉很快" | < 500ms 返回结果                            |
| 对话流畅       | 首 token < 1s，流式无卡顿                   |
| 截图录制无感   | CPU < 5%（稳态），内存 < 100MB（Collector） |
| 启动快速       | Engine 就绪 < 3s                            |

---

## 2. 各组件性能目标

### 2.1 Collector（截图采集）

| 指标                | 目标                    | 说明                         |
| ------------------- | ----------------------- | ---------------------------- |
| 截图间隔            | 2s（活跃）/ 10s（空闲） | TDR-012                      |
| 单帧 diff 检测      | < 50ms                  | 像素级比较                   |
| WebP 压缩           | < 200ms                 | 2560×1440 @ quality 80       |
| OCR（Apple Vision） | < 500ms                 | 单帧                         |
| HTTP POST 到 Engine | < 100ms                 | localhost 网络               |
| 稳态 CPU            | < 5%                    | 单核占比                     |
| 稳态内存            | < 100MB                 | RSS                          |
| 一帧完整流程        | < 800ms                 | diff + compress + OCR + POST |

### 2.2 Ingestion Pipeline（摄入管线）

| 指标                    | 目标     | 说明                          |
| ----------------------- | -------- | ----------------------------- |
| 队列等待 → 开始处理     | < 1s     | 正常负载                      |
| 中文分词（jieba-wasm）  | < 50ms   | 单条 OCR 文本                 |
| NER 实体提取            | < 200ms  | 云端 LLM                      |
| Embedding 生成（单条）  | < 200ms  | 云端 BGE-M3 API               |
| Embedding 批量（32 条） | < 2s     | 云端批量 API                  |
| SurrealDB 写入（单条）  | < 50ms   | 含索引更新                    |
| 单截图完整摄入          | < 1s     | 分词 + NER + embedding + 存储 |
| 吞吐量                  | ≥ 5 条/s | 稳态处理速率                  |

### 2.3 Vision LLM（活动理解）

| 指标                  | 目标    | 说明               |
| --------------------- | ------- | ------------------ |
| 帧选择算法            | < 100ms | OCR 文本相似度计算 |
| Vision LLM 调用       | < 10s   | 含 8 帧图片输入    |
| activity_segment 写入 | < 50ms  | SurrealDB          |
| 单 Session 完整处理   | < 15s   | 选帧 + LLM + 存储  |

### 2.4 Search（搜索引擎）

| 指标                   | 目标    | 说明                   |
| ---------------------- | ------- | ---------------------- |
| Embedding 查询向量生成 | < 200ms | 查询文本 → BGE-M3      |
| 向量搜索（HNSW）       | < 100ms | Top-50                 |
| 全文搜索               | < 100ms | SurrealDB FTS          |
| 图搜索（实体关联）     | < 200ms | 2 层 graph traversal   |
| 混合搜索（总体）       | < 500ms | 并行 3 策略 + RRF 融合 |
| 搜索建议               | < 200ms | 前缀匹配 + 频率排序    |

### 2.5 Agent（AI 对话）

| 指标             | 目标  | 说明           |
| ---------------- | ----- | -------------- |
| 意图理解         | < 2s  | LLM 首次调用   |
| 工具调用（单次） | < 1s  | 搜索/查询工具  |
| 首 token 延迟    | < 1s  | 流式响应       |
| 完整回复         | < 15s | 含多轮工具调用 |
| 最大工具轮数     | 10    | maxSteps 限制  |

### 2.6 API（HTTP 服务）

| 端点                      | 目标延迟（P95） | 说明              |
| ------------------------- | --------------- | ----------------- |
| `GET /health`             | < 50ms          | 健康检查          |
| `POST /ingest/screenshot` | < 100ms         | 入队即返回 202    |
| `POST /search`            | < 500ms         | 含 embedding 生成 |
| `GET /timeline`           | < 300ms         | 分页查询          |
| `GET /entities`           | < 200ms         | 列表查询          |
| `GET /entities/:id/graph` | < 500ms         | 图遍历            |
| `GET /screenshots/:id`    | < 100ms         | 单条查询          |
| `GET /stats/overview`     | < 200ms         | 聚合统计          |

### 2.7 Engine 进程

| 指标          | 目标          | 说明                        |
| ------------- | ------------- | --------------------------- |
| 启动时间      | < 3s          | 含 DB 连接 + migration 检查 |
| 稳态内存      | < 200MB       | RSS，不含 HNSW 索引         |
| HNSW 索引内存 | ~5-6KB/vector | 参考 operational-design.md  |
| 优雅关闭      | < 60s         | 含队列排空                  |

---

## 3. 性能测量方法

### 3.1 内置计时

使用日志规范中的 `createTimer` 工具：

```typescript
const result = await time("hybrid search", () =>
  searchService.hybridSearch(query),
);
// 日志输出: { durationMs: 342 } "hybrid search completed"
```

### 3.2 Health API 指标

`GET /api/v1/health` 暴露实时指标（详见 `operational-design.md`）：

```json
{
  "metrics": {
    "ingestion_queue_depth": 3,
    "ingestion_avg_latency_ms": 850,
    "search_avg_latency_ms": 320,
    "memory_usage_mb": 156,
    "screenshot_count_today": 1240
  }
}
```

### 3.3 基准测试脚本

```typescript
// scripts/benchmark-search.ts
const queries = ["VS Code", "张三", "Slack 讨论", "terminal git"];
const iterations = 100;

for (const query of queries) {
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await searchService.hybridSearch({ text: query });
    times.push(performance.now() - start);
  }
  console.log(
    `"${query}": p50=${percentile(times, 50)}ms p95=${percentile(times, 95)}ms`,
  );
}
```

---

## 4. 性能预算

### 数据规模估算

| 时间段 | 截图量 | 向量索引内存 | 数据库体积 |
| ------ | ------ | ------------ | ---------- |
| 1 个月 | ~40K   | ~240MB       | ~5GB       |
| 6 个月 | ~240K  | ~1.4GB       | ~30GB      |
| 1 年   | ~500K  | ~3GB         | ~60GB      |
| 3 年   | ~1.5M  | ~9GB         | ~180GB     |

### 降级策略

| 触发条件         | 动作                                  |
| ---------------- | ------------------------------------- |
| 搜索 > 2s（P95） | 检查 HNSW 索引、增加预过滤            |
| 内存 > 1GB       | 检查泄漏、评估降维（1024→512）        |
| 摄入吞吐 < 2/s   | 检查 embedding API、增加批量大小      |
| 磁盘 < 10GB      | 启动清理策略（operational-design.md） |

---

## 5. 性能回归检测

### CI 中的性能检查

```bash
# 基准测试（可选，大型变更时运行）
bun run benchmark

# 结果对比
# 如果 P95 延迟增长 > 20%，发出警告
```

### 开发者自查

每次涉及以下模块的变更，手动验证性能：

- `search/` — 运行搜索基准
- `ingestion/` — 验证摄入吞吐
- `storage/` — 检查查询延迟
- `ai/` — 验证 API 调用延迟
