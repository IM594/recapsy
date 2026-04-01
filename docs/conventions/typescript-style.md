# TypeScript 编码规范

> 适用范围：`packages/engine/`、`packages/shared/`

## 1. 总体原则

- **偏函数式**：纯函数 + 组合优先，class 仅用于错误类型和极少数有状态场景
- **类型严格**：`strict: true`，零 `any`，最小化 `as` 断言
- **显式优于隐式**：返回类型显式声明，依赖显式传入
- **一个文件一个职责**：文件不超过 300 行（超过则拆分）

---

## 2. 命名约定

### 变量与函数

```typescript
// camelCase — 变量、函数、参数
const screenshotCount = 42;
function findByTimeRange(start: Date, end: Date) { ... }

// 布尔值：is/has/should/can 前缀
const isActive = true;
const hasOcrText = ocr_text !== null;
const shouldRetry = retryCount < MAX_RETRIES;

// 常量：UPPER_SNAKE_CASE
const MAX_RETRY_COUNT = 3;
const DEFAULT_PORT = 21890;
const EMBEDDING_DIMENSIONS = 1024;
```

### 类型与接口

```typescript
// PascalCase — 类型、接口、枚举、class
type EntityType = "person" | "app" | "url" | "topic" | "project";
interface ScreenshotRepository { ... }
class StorageError extends AppError { ... }

// 不加 I 前缀（不写 IScreenshotRepository）
interface ScreenshotRepository { ... }  ✅
interface IScreenshotRepository { ... } ❌
```

### 文件命名

```
kebab-case.ts          # 所有 TypeScript 文件
screenshot-repository.ts
search-service.ts
ingestion-pipeline.ts

# 特殊后缀
*.test.ts              # 测试文件
*.types.ts             # 纯类型定义文件（仅在类型复杂时拆分）
*.schema.ts            # Zod schema 定义
*.errors.ts            # 错误类型定义
```

### 目录命名

```
kebab-case/            # 所有目录
src/
  ingestion/
    ingestion-pipeline.ts
    screenshot-processor.ts
  search/
    vector-search.ts
    fulltext-search.ts
```

---

## 3. 函数式风格约定

### 纯函数优先

```typescript
// ✅ 纯函数：输入决定输出，无副作用
function calculateDiffRatio(current: Buffer, previous: Buffer): number {
  // ...
  return ratio;
}

// ✅ 依赖通过参数传入（轻量 DI）
function createSearchService(deps: {
  db: ScreenshotRepository;
  embedder: EmbeddingProvider;
}) {
  return {
    search: async (query: SearchQuery): Promise<SearchResult> => {
      const embedding = await deps.embedder.embed(query.text);
      return deps.db.findByVector(embedding);
    },
  };
}

// ❌ 避免：模块级可变状态
let globalConfig: Config; // bad
```

### 工厂函数替代 class

```typescript
// ✅ 工厂函数 + 闭包（推荐模式）
export function createIngestionPipeline(deps: IngestionDeps) {
  // 私有状态通过闭包隐藏
  const queue: Screenshot[] = [];

  async function processScreenshot(input: IngestInput): Promise<void> {
    // ...
  }

  async function getQueueDepth(): Promise<number> {
    return queue.length;
  }

  return { processScreenshot, getQueueDepth };
}

export type IngestionPipeline = ReturnType<typeof createIngestionPipeline>;

// ❌ 避免：不必要的 class
class IngestionPipeline {
  private queue: Screenshot[] = [];
  constructor(private deps: IngestionDeps) {}
  // ...
}
```

### class 仅用于错误类型

```typescript
// ✅ 错误类型用 class（需要 instanceof 检查）
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class StorageError extends AppError {
  constructor(message: string, cause?: unknown) {
    super("STORAGE_ERROR", message, cause);
  }
}

export class ValidationError extends AppError {
  constructor(
    message: string,
    public readonly field?: string,
  ) {
    super("VALIDATION_ERROR", message);
  }
}
```

---

## 4. 依赖注入模式

### 模块级：Deps 接口 + 工厂函数

```typescript
// search/search-service.ts

// 1. 声明依赖接口
interface SearchDeps {
  screenshotRepo: ScreenshotRepository;
  entityRepo: EntityRepository;
  embedder: EmbeddingProvider;
  logger: Logger;
}

// 2. 工厂函数接受依赖
export function createSearchService(deps: SearchDeps) {
  const { screenshotRepo, entityRepo, embedder, logger } = deps;

  async function hybridSearch(query: SearchQuery): Promise<SearchResult> {
    logger.info({ query: query.text }, "executing hybrid search");
    // ...
  }

  return { hybridSearch };
}
```

### 应用入口：组装依赖

```typescript
// main.ts — 唯一做"组装"的地方
import { createSearchService } from "./search/search-service";
import { createScreenshotRepo } from "./storage/screenshot-repository";
import { createEmbedder } from "./ai/embedding-provider";

const db = await connectSurrealDB(config.db);
const screenshotRepo = createScreenshotRepo(db);
const embedder = createEmbedder(config.ai);
const logger = createLogger("search");

const searchService = createSearchService({
  screenshotRepo,
  entityRepo,
  embedder,
  logger,
});
```

### 好处

- 测试时直接传入 mock，无需 DI 框架
- 依赖关系在类型层面显式可见
- 符合架构文档的单向依赖规则

---

## 5. 异步模式

### async/await 优先

```typescript
// ✅ async/await
async function saveScreenshot(input: IngestInput): Promise<Screenshot> {
  const screenshot = await screenshotRepo.save(input);
  await indexService.index(screenshot);
  return screenshot;
}

// ❌ 避免回调嵌套和 .then() 链
function saveScreenshot(input: IngestInput) {
  return screenshotRepo.save(input).then((screenshot) => {
    return indexService.index(screenshot).then(() => screenshot);
  });
}
```

### 并发控制

```typescript
// ✅ 独立任务并行
const [screenshots, entities] = await Promise.all([
  screenshotRepo.findByTimeRange(start, end),
  entityRepo.findByType("person"),
]);

// ✅ 批量处理带并发限制
async function processInBatches<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}
```

### 错误处理

```typescript
// ✅ 在模块边界捕获并包装错误
async function findScreenshot(id: string): Promise<Screenshot> {
  try {
    const result = await db.query(`SELECT * FROM screenshot WHERE id = $id`, { id });
    if (!result) throw new NotFoundError(`Screenshot ${id} not found`);
    return result;
  } catch (error) {
    if (error instanceof AppError) throw error; // 已知错误直接抛出
    throw new StorageError(`Failed to find screenshot ${id}`, error);
  }
}

// ❌ 避免：吞掉错误
async function findScreenshot(id: string) {
  try {
    return await db.query(...);
  } catch {
    return null; // 错误被吞掉，调用者不知道发生了什么
  }
}
```

---

## 6. 类型系统约定

### 严格模式

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "strict": true, // 所有严格检查
    "noUncheckedIndexedAccess": true, // arr[0] 返回 T | undefined
    "exactOptionalProperties": true, // 区分 undefined 和 missing
    "noImplicitReturns": true,
  },
}
```

### 零 `any` 策略

```typescript
// ✅ unknown + 类型收窄
function handleError(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

// ✅ 泛型替代 any
function first<T>(items: T[]): T | undefined {
  return items[0];
}

// ❌ 绝对禁止
function processData(data: any) { ... }

// ⚠️ 极少数例外：第三方库类型不完整时，用 as unknown as TargetType
// 必须加注释说明原因
const result = externalLib.call() as unknown as ExpectedType; // surrealdb types incomplete
```

### Zod 作为 Single Source of Truth

```typescript
// ✅ Zod schema 定义 → 推导 TypeScript 类型
import { z } from "zod";

export const screenshotSchema = z.object({
  id: z.string(),
  path: z.string(),
  timestamp: z.coerce.date(),
  app_name: z.string(),
  bundle_id: z.string(),
  ocr_text: z.string().nullable(),
  diff_ratio: z.number().min(0).max(1),
  status: z.enum(["queued", "processing", "done", "dead_letter"]),
});

export type Screenshot = z.infer<typeof screenshotSchema>;

// ❌ 避免：手写 interface 和 Zod schema 分别维护
```

### 联合类型优于枚举

```typescript
// ✅ 字符串联合类型（tree-shakeable，JSON 兼容）
type SceneType = "coding" | "chatting" | "browsing" | "designing" | "reading";
type EntityType = "person" | "app" | "url" | "topic" | "project";

// ❌ 避免 TypeScript enum（运行时开销，bundle 不友好）
enum SceneType { Coding = "coding", ... }
```

### 善用 branded types

```typescript
// ✅ 防止 ID 混用
type ScreenshotId = string & { readonly __brand: "ScreenshotId" };
type EntityId = string & { readonly __brand: "EntityId" };

function findScreenshot(id: ScreenshotId): Promise<Screenshot> { ... }
findScreenshot("entity:abc" as ScreenshotId); // 调用者必须显式标记
```

---

## 7. 导入导出约定

### 导入顺序（Biome 自动排序）

```typescript
// 1. Node/Bun 内置模块
import { join } from "node:path";

// 2. 第三方库
import { Hono } from "hono";
import { z } from "zod";

// 3. monorepo 内部包
import type { Screenshot } from "@recaply/shared";

// 4. 当前包内模块（相对路径）
import { createSearchService } from "../search/search-service";
import { logger } from "../utils/logger";
```

### 导出方式

```typescript
// ✅ Named exports（所有文件）
export function createSearchService(deps: SearchDeps) { ... }
export type SearchResult = { ... };

// ✅ Barrel exports（每个子模块的 index.ts）
// search/index.ts
export { createSearchService } from "./search-service";
export type { SearchResult, SearchQuery } from "./search-types";

// ❌ 避免 default export（重构不友好、IDE 补全差）
export default function search() { ... }
```

### Type-only imports

```typescript
// ✅ 类型导入用 import type（编译后完全移除）
import type { Screenshot, Entity } from "@recaply/shared";
import { screenshotSchema } from "@recaply/shared";
```

---

## 8. 错误处理分层

```
AppError (base)
├── ValidationError    — 请求/输入校验失败 (400)
├── NotFoundError      — 资源不存在 (404)
├── StorageError       — 数据库操作失败 (500)
├── AIProviderError    — LLM/Embedding 调用失败 (502)
├── SearchError        — 搜索执行失败 (500)
├── IngestionError     — 摄入管线错误 (500)
├── ConfigError        — 配置无效 (500)
└── BudgetExceededError — AI 预算超限 (429)
```

**规则：**

- 每个 Engine 子模块定义自己的错误子类（在 `<module>/errors.ts`）
- 模块边界处捕获底层错误并包装为模块错误
- 绝不向上层泄露内部实现（如 SurrealDB 原始错误）
- API 层统一转换为 HTTP 错误响应

---

## 9. 注释规范

```typescript
// ✅ 解释 "为什么"（不解释 "是什么"）
// Skip frames with < 5% diff to filter cursor flicker (TDR-012)
if (diffRatio < MIN_DIFF_THRESHOLD) continue;

// ✅ 复杂算法的概述
// Frame selection: keep first + last + highest diff_ratio frames,
// deduplicate by OCR text similarity > 70%, cap at 8 frames
function selectRepresentativeFrames(frames: Frame[]): Frame[] { ... }

// ✅ TODO 格式（关联 issue 或说明原因）
// TODO(#42): replace with batch embedding API when available
// TODO: consider caching entity lookup results (measure first)

// ❌ 不写无意义注释
const port = 21890; // set port to 21890 (废话)
```

---

## 10. Biome 配置参考

```jsonc
// biome.json
{
  "$schema": "https://biomejs.dev/schemas/2.0/schema.json",
  "organizeImports": { "enabled": true },
  "formatter": {
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100,
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": {
        "noExplicitAny": "error", // 禁止 any
      },
      "style": {
        "noDefaultExport": "warn", // 避免 default export
        "useConst": "error", // 优先 const
        "noVar": "error", // 禁止 var
      },
      "complexity": {
        "noExcessiveCognitiveComplexity": {
          "level": "warn",
          "options": { "maxAllowedComplexity": 15 },
        },
      },
    },
  },
}
```
