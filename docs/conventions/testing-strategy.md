# 测试策略规范

> 适用范围：`packages/engine/`、`packages/shared/`（TypeScript）；Swift 端测试另见 `swift-style.md`

## 1. 总体目标

- **覆盖率目标**：80%（行覆盖率），核心模块（ingestion/search/storage）≥ 90%
- **测试框架**：`bun test`（内置，零配置，兼容 Jest API）
- **原则**：测试行为而非实现，快速反馈，可靠不 flaky

---

## 2. 测试金字塔

```
        ╱ E2E ╲                 少量（关键用户流程）
       ╱ Integration ╲          适量（模块间交互）
      ╱   Unit Tests   ╲        大量（函数/模块内部）
```

| 层级            | 数量占比 | 速度        | 范围          | 示例                          |
| --------------- | -------- | ----------- | ------------- | ----------------------------- |
| **Unit**        | ~70%     | < 50ms/case | 单个函数/模块 | `calculateDiffRatio()` 纯函数 |
| **Integration** | ~25%     | < 2s/case   | 模块间交互    | Ingestion → Storage 写入      |
| **E2E**         | ~5%      | < 10s/case  | 完整流程      | REST API → Search → 返回结果  |

---

## 3. 文件组织

### 目录结构

```
packages/engine/
  src/
    search/
      vector-search.ts
      fulltext-search.ts
      search-service.ts
  tests/
    unit/
      search/
        vector-search.test.ts
        fulltext-search.test.ts
    integration/
      search/
        search-service.test.ts
      ingestion/
        ingestion-pipeline.test.ts
    e2e/
      api/
        search-api.test.ts
        ingest-api.test.ts
    fixtures/
      screenshots/
        sample-screenshot.webp
      mock-ocr-text.ts
    helpers/
      test-db.ts            # 测试数据库 setup/teardown
      mock-providers.ts     # Mock AI providers
      factories.ts          # 测试数据工厂
```

### 文件命名

```
<source-file-name>.test.ts     # 与源文件同名
vector-search.test.ts          ✅
vectorSearchTest.ts            ❌
vector-search.spec.ts          ❌ (统一用 .test.ts)
```

---

## 4. 测试命名约定

### describe + it 结构

```typescript
describe("vectorSearch", () => {
  describe("search", () => {
    it("returns matching screenshots sorted by score", async () => { ... });
    it("returns empty array when no matches found", async () => { ... });
    it("respects time range filter", async () => { ... });
    it("throws SearchError when embedding fails", async () => { ... });
  });
});
```

### 命名规则

- **describe**：被测对象名（函数名/模块名）
- **it**：以动词开头，描述具体行为
  - `it("returns ...")`
  - `it("throws ... when ...")`
  - `it("filters ... by ...")`
  - `it("creates ... with default values")`

```typescript
// ✅ 好的命名
it("returns screenshots within the specified time range", ...)
it("throws StorageError when database connection is lost", ...)
it("skips frame when diff ratio is below 5%", ...)

// ❌ 坏的命名
it("works correctly", ...)
it("test search", ...)
it("should return results", ...)   // 不用 should 前缀
```

---

## 5. 测试模式

### 5.1 AAA 模式（Arrange-Act-Assert）

```typescript
it("embeds screenshot text and stores vector", async () => {
  // Arrange
  const mockEmbedder = createMockEmbedder([0.1, 0.2, 0.3]);
  const pipeline = createIngestionPipeline({ embedder: mockEmbedder, ... });
  const input = createScreenshotInput({ ocr_text: "hello world" });

  // Act
  const result = await pipeline.processScreenshot(input);

  // Assert
  expect(result.embedding).toHaveLength(1024);
  expect(mockEmbedder.embed).toHaveBeenCalledWith("hello world");
});
```

### 5.2 Mock 策略：依赖注入 Mock

利用 `typescript-style.md` 定义的工厂函数 + Deps 模式，测试时直接传入 mock：

```typescript
// helpers/mock-providers.ts

export function createMockScreenshotRepo(
  overrides: Partial<ScreenshotRepository> = {},
): ScreenshotRepository {
  return {
    save: async () => ({ id: "screenshot:test" }) as Screenshot,
    findByTimeRange: async () => [],
    findByApp: async () => [],
    findByVector: async () => [],
    ...overrides,
  };
}

export function createMockEmbedder(
  embedding: number[] = new Array(1024).fill(0),
): EmbeddingProvider {
  return {
    embed: async () => embedding,
    embedBatch: async (texts) => texts.map(() => embedding),
  };
}
```

```typescript
// 使用
it("calls repository with correct time range", async () => {
  const findByTimeRange = vi.fn().mockResolvedValue([sampleScreenshot]);
  const repo = createMockScreenshotRepo({ findByTimeRange });
  const service = createSearchService({ screenshotRepo: repo, ... });

  await service.hybridSearch({ text: "test", timeRange: { start, end } });

  expect(findByTimeRange).toHaveBeenCalledWith(start, end);
});
```

**规则：**

- ❌ 禁止 mock 模块级导入（`jest.mock("../module")`）— 脆弱且耦合实现
- ✅ 通过 Deps 接口注入 mock — 类型安全，重构友好
- ✅ 外部服务（SurrealDB、LLM API）总是 mock（单元测试）
- ✅ Integration test 可使用真实 SurrealDB（内存模式）

### 5.3 测试数据工厂

```typescript
// helpers/factories.ts

let counter = 0;

export function createScreenshotInput(
  overrides: Partial<IngestInput> = {},
): IngestInput {
  counter++;
  return {
    path: `/screenshots/2026/03/31/120000_abc${counter}.webp`,
    timestamp: new Date("2026-03-31T12:00:00Z"),
    app_name: "VS Code",
    bundle_id: "com.microsoft.VSCode",
    window_title: "main.ts",
    display_id: 1,
    is_active: true,
    diff_ratio: 0.15,
    resolution: "2560x1440",
    file_size: 45000,
    ocr_text: "sample text",
    capture_id: `capture_${counter}`,
    timezone: "Asia/Shanghai",
    ...overrides,
  };
}

export function createEntity(overrides: Partial<Entity> = {}): Entity {
  counter++;
  return {
    id: `entity:test_${counter}`,
    type: "person",
    name: `Test Entity ${counter}`,
    aliases: [],
    metadata: null,
    first_seen: new Date(),
    last_seen: new Date(),
    frequency: 1,
    embedding: null,
    created_at: new Date(),
    ...overrides,
  };
}
```

### 5.4 异步测试

```typescript
// ✅ 直接 async/await
it("processes screenshot through full pipeline", async () => {
  const result = await pipeline.processScreenshot(input);
  expect(result.status).toBe("done");
});

// ✅ 测试异步错误
it("throws IngestionError on invalid screenshot path", async () => {
  const input = createScreenshotInput({ path: "/nonexistent.webp" });
  await expect(pipeline.processScreenshot(input)).rejects.toThrow(
    IngestionError,
  );
});

// ✅ 测试超时（默认 5s，特殊情况可调）
it("completes batch embedding within timeout", async () => {
  const texts = Array.from({ length: 100 }, (_, i) => `text ${i}`);
  const result = await embedder.embedBatch(texts);
  expect(result).toHaveLength(100);
}, 10_000); // 10s timeout for batch test
```

---

## 6. 集成测试

### SurrealDB 测试环境

```typescript
// helpers/test-db.ts
import { Surreal } from "surrealdb";

let testDb: Surreal;

export async function setupTestDb(): Promise<Surreal> {
  testDb = new Surreal();
  // In-memory mode for tests (no disk I/O)
  await testDb.connect("mem://");
  await testDb.use({ namespace: "test", database: "test" });
  // Run schema migrations
  await applyMigrations(testDb);
  return testDb;
}

export async function teardownTestDb(): Promise<void> {
  await testDb?.close();
}

export async function cleanTestDb(): Promise<void> {
  // Clean all data between tests but keep schema
  await testDb.query("DELETE screenshot; DELETE entity; DELETE appeared_in;");
}
```

```typescript
// integration/storage/screenshot-repository.test.ts
import {
  setupTestDb,
  teardownTestDb,
  cleanTestDb,
} from "../../helpers/test-db";

describe("screenshotRepository (integration)", () => {
  let db: Surreal;
  let repo: ScreenshotRepository;

  beforeAll(async () => {
    db = await setupTestDb();
    repo = createScreenshotRepo(db);
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  afterEach(async () => {
    await cleanTestDb();
  });

  it("saves and retrieves screenshot by id", async () => {
    const input = createScreenshotInput();
    const saved = await repo.save(input);
    const found = await repo.findById(saved.id);
    expect(found).toMatchObject({ app_name: input.app_name });
  });
});
```

### API 集成测试

```typescript
// e2e/api/search-api.test.ts
import { createApp } from "../../src/api/app";

describe("POST /api/v1/search (e2e)", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    app = await createApp(testConfig);
    // Seed test data
    await seedTestData(app.deps.db);
  });

  it("returns search results with correct format", async () => {
    const response = await app.request("/api/v1/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "VS Code", limit: 10 }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.screenshots).toBeInstanceOf(Array);
    expect(body.strategy_used).toBeDefined();
  });
});
```

---

## 7. 测试运行配置

### 命令

```bash
# 运行所有测试
cd packages/engine && bun test

# 运行特定层级
bun test tests/unit/             # 仅单元测试
bun test tests/integration/      # 仅集成测试
bun test tests/e2e/              # 仅 E2E

# 运行特定模块
bun test tests/unit/search/

# Watch 模式（开发时）
bun test --watch

# 覆盖率报告
bun test --coverage
```

### package.json scripts

```json
{
  "scripts": {
    "test": "bun test",
    "test:unit": "bun test tests/unit/",
    "test:integration": "bun test tests/integration/",
    "test:e2e": "bun test tests/e2e/",
    "test:coverage": "bun test --coverage",
    "test:watch": "bun test --watch"
  }
}
```

---

## 8. 覆盖率规则

### 目标

| 模块         | 行覆盖率 | 理由                      |
| ------------ | -------- | ------------------------- |
| `storage/`   | ≥ 90%    | 数据正确性关键            |
| `ingestion/` | ≥ 90%    | 管线稳定性关键            |
| `search/`    | ≥ 90%    | 核心功能                  |
| `agent/`     | ≥ 80%    | LLM 行为难以确定性测试    |
| `ai/`        | ≥ 70%    | 外部 API 封装，主要测接口 |
| `api/`       | ≥ 80%    | 通过 E2E 补充             |
| `mcp/`       | ≥ 80%    | 通过 E2E 补充             |
| `vision/`    | ≥ 80%    | LLM 行为难以确定性测试    |
| `shared/`    | ≥ 90%    | 纯逻辑，易测试            |

### 不需要测试的

- 类型定义文件（`.types.ts`）
- Zod schema 定义（`.schema.ts`）— 运行时自动校验
- 配置常量
- `main.ts` 应用入口（依赖组装代码）

---

## 9. 测试最佳实践

### DO ✅

```typescript
// 一个测试只验证一个行为
it("filters screenshots by app name", async () => { ... });
it("returns empty when no app matches", async () => { ... });

// 测试边界条件
it("handles empty ocr_text", async () => { ... });
it("truncates text longer than 6000 chars", async () => { ... });
it("deduplicates by capture_id", async () => { ... });

// 测试错误场景
it("throws StorageError when db is unreachable", async () => { ... });
it("retries up to 3 times on transient failure", async () => { ... });
it("moves to dead letter after max retries", async () => { ... });
```

### DON'T ❌

```typescript
// 不测试实现细节
it("calls db.query with correct SQL", async () => { ... }); // 耦合 SurrealQL

// 不测试第三方库行为
it("zod validates email format", () => { ... }); // 那是 Zod 的测试

// 不写多余断言
expect(result).not.toBeNull();
expect(result).toBeDefined();
expect(result).toBeTruthy();  // 三个断言说的同一件事

// 不依赖测试执行顺序
it("updates the entity created in previous test", ...); // 测试应独立
```

---

## 10. CI 中的测试

```yaml
# 在 CI/CD 中（详见 ci-cd-pipeline.md）
- name: Unit Tests
  run: cd packages/engine && bun test tests/unit/
  # 快速，每次 push 运行

- name: Integration Tests
  run: cd packages/engine && bun test tests/integration/
  # 需要 SurrealDB，PR 合并前运行

- name: Coverage Check
  run: cd packages/engine && bun test --coverage
  # 检查是否低于 80% 阈值
```
