# CI/CD 流水线设计

> 适用范围：GitHub Actions，monorepo 全局

## 1. 总体策略

- **平台**：GitHub Actions
- **触发模型**：Push to `main` + PR + 手动触发
- **缓存策略**：Bun 依赖缓存 + Turborepo 远程缓存
- **并行化**：独立 job 并行执行，依赖 job 串行

---

## 2. Workflow 概览

```
┌─────────────────────────────────────────────────────┐
│  on: push (main) / pull_request                     │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌─────────┐   ┌──────────┐   ┌─────────────────┐  │
│  │  Lint   │   │  Type    │   │  Commit Lint    │  │
│  │ (Biome) │   │  Check   │   │ (commitlint)    │  │
│  └────┬────┘   └────┬─────┘   └────────┬────────┘  │
│       │              │                  │            │
│       └──────────┬───┘──────────────────┘            │
│                  ▼                                    │
│  ┌──────────────────────────────────┐                │
│  │        Unit Tests (bun test)     │                │
│  └──────────────┬───────────────────┘                │
│                 ▼                                     │
│  ┌──────────────────────────────────┐                │
│  │    Integration Tests + Coverage   │                │
│  └──────────────┬───────────────────┘                │
│                 ▼                                     │
│  ┌──────────────────────────────────┐                │
│  │        Build (turbo build)        │                │
│  └──────────────────────────────────┘                │
└─────────────────────────────────────────────────────┘
```

---

## 3. 核心 Workflow：CI

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true # PR 更新时取消旧 run

env:
  BUN_VERSION: "1.2"

jobs:
  # ──────────── 静态检查（并行）────────────
  lint:
    name: Lint (Biome)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${{ env.BUN_VERSION }}
      - run: bun install --frozen-lockfile
      - run: bun run lint

  typecheck:
    name: Type Check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${{ env.BUN_VERSION }}
      - run: bun install --frozen-lockfile
      - run: bun run typecheck

  commitlint:
    name: Commit Message Lint
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${{ env.BUN_VERSION }}
      - run: bun install --frozen-lockfile
      - run: bunx commitlint --from ${{ github.event.pull_request.base.sha }}

  # ──────────── 测试（依赖静态检查）────────────
  test-unit:
    name: Unit Tests
    runs-on: ubuntu-latest
    needs: [lint, typecheck]
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${{ env.BUN_VERSION }}
      - run: bun install --frozen-lockfile
      - run: cd packages/engine && bun test tests/unit/

  test-integration:
    name: Integration Tests
    runs-on: ubuntu-latest
    needs: [lint, typecheck]
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${{ env.BUN_VERSION }}
      - name: Install SurrealDB
        run: curl -sSf https://install.surrealdb.com | sh
      - run: bun install --frozen-lockfile
      - run: cd packages/engine && bun test tests/integration/

  test-coverage:
    name: Coverage Report
    runs-on: ubuntu-latest
    needs: [test-unit, test-integration]
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${{ env.BUN_VERSION }}
      - name: Install SurrealDB
        run: curl -sSf https://install.surrealdb.com | sh
      - run: bun install --frozen-lockfile
      - run: cd packages/engine && bun test --coverage
      # TODO: add coverage threshold check and badge

  # ──────────── 构建（依赖测试）────────────
  build:
    name: Build
    runs-on: ubuntu-latest
    needs: [test-unit]
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${{ env.BUN_VERSION }}
      - run: bun install --frozen-lockfile
      - run: bun run build
```

---

## 4. Swift 构建 Workflow

```yaml
# .github/workflows/swift.yml
name: Swift Build

on:
  push:
    branches: [main]
    paths:
      - "apps/desktop/**"
      - "apps/collector/**"
      - "packages/shared/swift/**"
  pull_request:
    paths:
      - "apps/desktop/**"
      - "apps/collector/**"
      - "packages/shared/swift/**"

jobs:
  build-collector:
    name: Build Collector
    runs-on: macos-15 # macOS with Xcode
    steps:
      - uses: actions/checkout@v4
      - run: cd apps/collector && swift build -c release

  build-desktop:
    name: Build Desktop
    runs-on: macos-15
    steps:
      - uses: actions/checkout@v4
      - run: |
          cd apps/desktop
          xcodebuild -scheme RecaplySense \
            -destination "platform=macOS" \
            -configuration Release \
            build
```

---

## 5. 缓存策略

### Bun 依赖缓存

```yaml
- uses: actions/cache@v4
  with:
    path: ~/.bun/install/cache
    key: bun-${{ runner.os }}-${{ hashFiles('**/bun.lock') }}
    restore-keys: |
      bun-${{ runner.os }}-
```

### Turborepo 缓存

```yaml
# 使用 Turborepo 远程缓存（可选）
env:
  TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
  TURBO_TEAM: ${{ vars.TURBO_TEAM }}
```

本地开发也受益于 Turborepo 增量构建缓存（`.turbo/` 目录）。

---

## 6. 路径过滤

避免无关变更触发完整 CI：

```yaml
# Engine 变更 → 跑 TS 检查 + 测试
paths:
  - "packages/engine/**"
  - "packages/shared/**"
  - "package.json"
  - "bun.lock"

# Swift 变更 → 跑 Swift 构建
paths:
  - "apps/desktop/**"
  - "apps/collector/**"

# 文档变更 → 仅跑 lint（如 markdownlint）
paths:
  - "docs/**"
  - "**.md"
```

---

## 7. Branch Protection（推荐配置）

`main` 分支保护规则（GitHub Settings → Branches）：

| 规则                              | 设置                          |
| --------------------------------- | ----------------------------- |
| Require status checks             | ✅ lint, typecheck, test-unit |
| Require branches to be up to date | ✅                            |
| Require conversation resolution   | ✅（未来协作时）              |
| Allow force pushes                | ❌                            |
| Allow deletions                   | ❌                            |

---

## 8. Secrets 管理

| Secret                 | 用途               | 必要性 |
| ---------------------- | ------------------ | ------ |
| `TURBO_TOKEN`          | Turborepo 远程缓存 | 可选   |
| `APPLE_CERTIFICATE`    | macOS 签名证书     | 发布时 |
| `APPLE_NOTARIZATION_*` | 公证凭据           | 发布时 |

**规则：**

- 不在 CI 中使用 AI API keys（测试用 mock）
- Secrets 只在需要的 job 中引用（最小权限）
- 定期轮换签名证书

---

## 9. 手动触发 Workflow

```yaml
# .github/workflows/release.yml
name: Release

on:
  workflow_dispatch:
    inputs:
      version:
        description: "Release version (e.g., 0.2.0)"
        required: true
        type: string
      channel:
        description: "Release channel"
        required: true
        type: choice
        options:
          - beta
          - stable
```

---

## 10. CI 优化原则

| 原则                    | 做法                                   |
| ----------------------- | -------------------------------------- |
| **快速反馈**            | 静态检查（< 1min）先行，通过后才跑测试 |
| **并行化**              | lint / typecheck / commitlint 同时跑   |
| **取消旧 run**          | `concurrency` + `cancel-in-progress`   |
| **路径过滤**            | 只跑受影响模块的检查                   |
| **缓存**                | Bun 依赖 + Turborepo 构建缓存          |
| **最小化 macOS runner** | macOS runner 贵 10x，仅 Swift 构建使用 |

### 目标耗时

| 阶段                     | 目标        |
| ------------------------ | ----------- |
| Lint + Typecheck         | < 1 min     |
| Unit Tests               | < 2 min     |
| Integration Tests        | < 5 min     |
| Build                    | < 3 min     |
| **Total (push to main)** | **< 8 min** |
