# 日志规范

> 适用范围：`packages/engine/`（Pino 日志）

## 1. 日志库

- **Pino**：高性能 JSON logger，Bun 原生兼容
- **pino-roll**：日志文件轮转
- **pino-pretty**：开发环境可读输出（仅 dev 依赖）

---

## 2. 日志级别使用标准

| 级别    | 数值 | 用途                     | 示例                                        |
| ------- | ---- | ------------------------ | ------------------------------------------- |
| `fatal` | 60   | 进程即将退出的致命错误   | DB 连接彻底失败、端口被占用                 |
| `error` | 50   | 操作失败但进程继续运行   | LLM 调用超时、截图处理失败进入 dead letter  |
| `warn`  | 40   | 异常但可恢复的情况       | 重试中、配置 fallback、磁盘空间 < 10GB      |
| `info`  | 30   | 关键业务事件（默认级别） | 服务启动/关闭、截图入库、搜索执行、会话创建 |
| `debug` | 20   | 开发调试详情             | SQL 查询、embedding 维度、中间计算结果      |
| `trace` | 10   | 极细粒度跟踪             | HTTP 请求头、原始 OCR 文本、逐帧 diff 值    |

### 级别选择速查

```
问自己：这条日志在生产环境需要看到吗？
  ├─ 是：进程要挂了吗？ → fatal
  │      操作失败了吗？ → error
  │      有风险但还行？ → warn
  │      正常业务事件？ → info
  └─ 否：帮助定位 bug？ → debug
         逐步跟踪执行？ → trace
```

### 环境默认级别

| 环境        | 默认级别 | 输出格式                       |
| ----------- | -------- | ------------------------------ |
| development | `debug`  | pino-pretty（彩色可读）        |
| production  | `info`   | JSON（结构化，适合 `jq` 查询） |
| test        | `warn`   | JSON（减少测试噪音）           |

---

## 3. Logger 创建约定

### 模块级 Logger

每个 Engine 子模块创建自己的 child logger：

```typescript
// utils/logger.ts — 根 logger 工厂
import pino from "pino";

export function createRootLogger(config: { level: string; env: string }) {
  return pino({
    level: config.level,
    transport:
      config.env === "development"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
    base: { service: "recaply-engine" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}

export type Logger = pino.Logger;
```

```typescript
// 各子模块中使用 child logger
// ingestion/ingestion-pipeline.ts
export function createIngestionPipeline(deps: { logger: Logger; ... }) {
  const log = deps.logger.child({ module: "ingestion" });

  async function processScreenshot(input: IngestInput) {
    log.info({ captureId: input.capture_id }, "processing screenshot");
    // ...
    log.debug({ screenshotId, embeddingDim: 1024 }, "embedding generated");
  }

  return { processScreenshot };
}
```

### 命名规则

```typescript
// module 字段使用子模块名
logger.child({ module: "ingestion" });
logger.child({ module: "search" });
logger.child({ module: "storage" });
logger.child({ module: "agent" });
logger.child({ module: "api" });
logger.child({ module: "mcp" });
logger.child({ module: "vision" });
logger.child({ module: "ai" });
```

---

## 4. 结构化字段约定

### 通用字段

所有日志自动包含：

```json
{
  "level": "info",
  "time": "2026-03-31T12:00:00.000Z",
  "service": "recaply-engine",
  "module": "ingestion"
}
```

### 业务字段命名

使用 **camelCase**，语义明确：

| 字段           | 类型   | 含义                |
| -------------- | ------ | ------------------- |
| `screenshotId` | string | 截图 ID             |
| `entityId`     | string | 实体 ID             |
| `captureId`    | string | 幂等 ID             |
| `sessionId`    | string | 对话/App Session ID |
| `appName`      | string | 应用名称            |
| `bundleId`     | string | Bundle ID           |
| `query`        | string | 搜索/chat 查询文本  |
| `strategy`     | string | 搜索策略            |
| `durationMs`   | number | 耗时（毫秒）        |
| `count`        | number | 数量                |
| `batchSize`    | number | 批量大小            |
| `retryCount`   | number | 重试次数            |
| `queueDepth`   | number | 队列深度            |
| `statusCode`   | number | HTTP 状态码         |
| `method`       | string | HTTP 方法           |
| `path`         | string | HTTP 路径           |
| `error`        | object | 错误信息（见下文）  |

### 错误日志字段

```typescript
// ✅ 结构化错误
log.error(
  {
    error: {
      code: err.code,
      message: err.message,
      stack: err.stack,
      cause: err.cause instanceof Error ? err.cause.message : undefined,
    },
    screenshotId,
    retryCount,
  },
  "screenshot processing failed",
);

// ❌ 避免：直接传 Error 对象
log.error(err, "something failed"); // 有时不含完整 stack
```

---

## 5. 日志消息格式

### 消息规则

- **英文**，小写开头，不加句号
- **简短描述发生了什么**（具体数据放结构化字段）
- 使用现在进行时/过去完成时

```typescript
// ✅ 好的消息
log.info({ screenshotId, durationMs: 150 }, "screenshot processed");
log.info({ port: 21890 }, "server started");
log.warn({ retryCount: 2, screenshotId }, "retrying screenshot processing");
log.error({ error, screenshotId }, "screenshot processing failed");

// ❌ 坏的消息
log.info("Screenshot " + id + " processed in " + ms + "ms"); // 拼接字符串
log.info({}, "Processing screenshot..."); // 无结构化字段
log.info({ id }, "INFO: Screenshot has been successfully processed!"); // 冗余
```

### 关键业务事件（info 级别必须记录）

```typescript
// 服务生命周期
"server started";
"server shutting down";
"server stopped";
"database connected";
"database migration applied";

// 截图摄入
"screenshot received";
"screenshot processed";
"screenshot moved to dead letter";
"batch ingestion completed";

// Vision LLM
"app session started";
"app session ended";
"activity segment generated";

// 搜索
"search executed";

// AI Agent
"chat session created";
"agent tool called";
"agent response completed";

// Collector
"collector heartbeat received";
"collector status changed";

// 系统
"backup started";
"backup completed";
"cleanup executed";
```

---

## 6. 敏感数据脱敏

### 绝对不记录

- 用户 OCR 文本全文（可能含密码、token、私人信息）
- API keys / tokens
- 完整文件路径（可能暴露用户名）

### 脱敏策略

```typescript
// ✅ OCR 文本只记录长度
log.debug(
  { ocrTextLength: ocrText.length, truncated: ocrText.length > 6000 },
  "ocr text received",
);

// ✅ 文件路径脱敏（去除用户目录前缀）
function sanitizePath(fullPath: string): string {
  return fullPath.replace(/^\/Users\/[^/]+/, "~");
}
log.info({ path: sanitizePath(screenshot.path) }, "screenshot saved");

// ✅ 搜索查询可记录（用户主动输入，非敏感）
log.info({ query: searchQuery.text, strategy: "hybrid" }, "search executed");

// ❌ 不记录
log.debug({ ocrText: fullOcrText }, "processing text"); // 可能含密码
log.info({ apiKey: config.openaiKey }, "ai configured"); // 泄露密钥
```

---

## 7. 请求级日志（HTTP 中间件）

```typescript
// api/middleware/request-logger.ts
import type { MiddlewareHandler } from "hono";

export function requestLogger(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const start = performance.now();
    const requestId = crypto.randomUUID();

    // Attach to context for downstream use
    c.set("requestId", requestId);
    c.set("logger", logger.child({ requestId }));

    await next();

    const durationMs = Math.round(performance.now() - start);
    const level =
      c.res.status >= 500 ? "error" : c.res.status >= 400 ? "warn" : "info";

    logger[level](
      {
        requestId,
        method: c.req.method,
        path: c.req.path,
        statusCode: c.res.status,
        durationMs,
      },
      "http request completed",
    );
  };
}
```

---

## 8. 性能计时

```typescript
// utils/timing.ts
export function createTimer(logger: Logger) {
  return function time<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return (async function timed(...args: unknown[]) {
      const start = performance.now();
      try {
        const result = await fn();
        const durationMs = Math.round(performance.now() - start);
        logger.debug({ durationMs }, `${label} completed`);
        return result;
      } catch (error) {
        const durationMs = Math.round(performance.now() - start);
        logger.error({ durationMs, error }, `${label} failed`);
        throw error;
      }
    })();
  };
}

// Usage
const embedding = await time("embedding generation", () =>
  embedder.embed(text),
);
```

---

## 9. 日志文件配置

```typescript
// Production 日志轮转配置
const transport = pino.transport({
  target: "pino-roll",
  options: {
    file: join(dataDir, "logs", "engine.log"),
    size: "50m", // 50MB per file
    limit: { count: 10 }, // keep 10 files
  },
});
```

### 日志文件查询

```bash
# 查看最近错误
cat engine.log | jq 'select(.level == "error")' | head -20

# 查看特定模块日志
cat engine.log | jq 'select(.module == "ingestion")'

# 查看慢请求（> 1s）
cat engine.log | jq 'select(.durationMs > 1000)'

# 查看截图处理失败
cat engine.log | jq 'select(.level == "error" and .module == "ingestion")'

# 按时间范围过滤
cat engine.log | jq 'select(.time > "2026-03-31T12:00" and .time < "2026-03-31T13:00")'
```
