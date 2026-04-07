# 开发者 Onboarding

> 从零搭建本地开发环境的完整指南

## 1. 系统要求

| 需求      | 最低版本   | 说明                                         |
| --------- | ---------- | -------------------------------------------- |
| macOS     | 13 Ventura | ScreenCaptureKit 要求                        |
| Xcode     | 15+        | Swift 6, SwiftUI                             |
| Bun       | 1.2+       | TypeScript 运行时                            |
| SurrealDB | 3.x        | 数据库（JS SDK `surrealdb@^2.0.3` 兼容 3.x） |
| Git       | 2.39+      | 版本控制                                     |

### 可选

| 工具   | 用途                           |
| ------ | ------------------------------ |
| Ollama | 本地 LLM 测试                  |
| jq     | 日志查询                       |
| Turbo  | Monorepo 编排（通过 bun 安装） |

---

## 2. 初始搭建

### 2.1 安装基础工具

```bash
# Xcode Command Line Tools（如未安装）
xcode-select --install

# Bun
curl -fsSL https://bun.sh/install | bash

# SurrealDB
curl -sSf https://install.surrealdb.com | sh

# 可选：Ollama（本地 LLM）
brew install ollama
```

### 2.2 克隆仓库

```bash
git clone https://github.com/<org>/recaply-sense.git
cd recaply-sense
```

### 2.3 安装依赖

```bash
# TypeScript 依赖
bun install

# 验证安装
bun run lint       # Biome lint
bun run typecheck  # TypeScript 类型检查
```

### 2.4 环境配置

```bash
# 复制环境变量模板
cp .env.example .env.local

# 编辑配置
vim .env.local
```

### 2.5 启动 SurrealDB（开发模式）

```bash
# 内存模式（快速开发，数据不持久化）
surreal start memory --user root --pass root --bind 127.0.0.1:8000

# 或文件模式（数据持久化）
surreal start file://~/Library/Application\ Support/RecaplySense/db \
  --user root --pass root --bind 127.0.0.1:8000
```

### 2.6 启动开发服务

```bash
# 全部启动（Turborepo 编排）
bun run dev

# 或分别启动
bun run dev:engine      # Engine（带 --watch 热重载）
```

### 2.7 验证

```bash
# Engine 健康检查
curl http://localhost:21890/api/v1/health

# 期望返回
# { "status": "ok", "version": "0.1.0", ... }
```

---

## 3. 环境变量

### `.env.example` 模板

```bash
# ─── Engine ───────────────────────────────────
# Server
ENGINE_PORT=21890
ENGINE_ENV=development    # development | production | test
ENGINE_LOG_LEVEL=debug    # trace | debug | info | warn | error | fatal

# Database
DB_MODE=embedded          # embedded | remote
DB_ENDPOINT=mem://        # mem:// (dev) | file://<path> | ws://localhost:8000
DB_NAMESPACE=recaply
DB_DATABASE=main
DB_USER=root              # 仅 remote 模式
DB_PASS=root              # 仅 remote 模式

# ─── AI Providers ─────────────────────────────
# Embedding (BGE-M3 via SiliconFlow)
EMBEDDING_PROVIDER=siliconflow   # siliconflow | local
EMBEDDING_API_KEY=               # SiliconFlow API key
EMBEDDING_API_URL=https://api.siliconflow.cn/v1/embeddings
EMBEDDING_MODEL=BAAI/bge-m3

# LLM (user chooses on first run, no default)
LLM_PROVIDER=                    # openai | anthropic | ollama
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
OLLAMA_BASE_URL=http://localhost:11434

# Vision LLM
VISION_LLM_PROVIDER=             # openai | anthropic | ollama | mistral | google
VISION_LLM_MODEL=                # e.g., gpt-4o-mini, claude-3-haiku
VISION_DAILY_BUDGET_USD=1.0

# ─── MCP Server ───────────────────────────────
MCP_STDIO_ENABLED=true
MCP_HTTP_ENABLED=true
MCP_HTTP_PORT=21891

# ─── Collector ────────────────────────────────
COLLECTOR_TOKEN=                  # Auto-generated UUID on first run
CAPTURE_INTERVAL_ACTIVE=2        # seconds
CAPTURE_INTERVAL_IDLE=10         # seconds
CAPTURE_QUALITY_ACTIVE=80        # WebP quality 0-100
CAPTURE_QUALITY_IDLE=40

# ─── Storage ──────────────────────────────────
DATA_DIR=~/Library/Application Support/RecaplySense
MAX_STORAGE_GB=500
AUTO_DELETE_AFTER_DAYS=           # null = never
```

### 规则

- `.env.example` 提交到 Git（无真实密钥，只有变量名和默认值）
- `.env.local` 在 `.gitignore` 中（含真实密钥，不提交）
- 生产环境通过系统环境变量或 `config.json` 注入
- 所有环境变量通过 Zod schema 校验（见 `typescript-style.md`）

---

## 4. 常用开发命令速查

```bash
# ─── 全局 ──────────────────────────
bun run dev              # 全部开发模式
bun run build            # 全部构建
bun run test             # 全部测试
bun run lint             # 全部 lint
bun run typecheck        # TypeScript 类型检查

# ─── Engine ────────────────────────
bun run dev:engine                       # 开发模式 (watch)
cd packages/engine && bun test           # 测试
cd packages/engine && bun test --watch   # 测试 watch
cd packages/engine && bun test --coverage # 覆盖率
cd packages/engine && biome check src/   # Lint

# ─── Shared ────────────────────────
cd packages/shared && bun test
bun run generate:schemas                 # Zod → JSON Schema
bun run generate:swift                   # JSON Schema → Swift types

# ─── Swift ─────────────────────────
bun run build:collector                  # swift build -c release
bun run build:desktop                    # xcodebuild

# ─── 数据库 ────────────────────────
surreal start memory --user root --pass root  # 开发 DB
surreal sql --conn ws://localhost:8000 --user root --pass root --ns recaply --db main

# ─── Git ───────────────────────────
git checkout -b feat/my-feature          # 新功能分支
git rebase -i origin/main               # 整理 commits
```

---

## 5. IDE 配置

### VS Code 推荐扩展

```jsonc
// .vscode/extensions.json
{
  "recommendations": [
    "biomejs.biome", // Biome linter/formatter
    "oven.bun-vscode", // Bun support
    "surrealdb.surrealql", // SurrealQL syntax
    "esbenp.prettier-vscode", // Markdown formatting
    "streetsidesoftware.code-spell-checker",
  ],
}
```

### VS Code 设置

```jsonc
// .vscode/settings.json（提交到 Git）
{
  "editor.defaultFormatter": "biomejs.biome",
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "source.organizeImports.biome": "explicit",
  },
  "[markdown]": {
    "editor.defaultFormatter": "esbenp.prettier-vscode",
  },
  "typescript.preferences.importModuleSpecifier": "non-relative",
}
```

---

## 6. 常见问题

### SurrealDB 连接失败

```bash
# 检查是否在运行
surreal version
# 确认端口没被占用
lsof -i :8000
```

### Biome lint 报错太多

```bash
# 自动修复
biome check --write src/
```

### Swift 构建失败

```bash
# 清理构建缓存
swift package clean
swift build
```

### Bun 依赖安装异常

```bash
# 清理缓存重装
rm -rf node_modules bun.lock
bun install
```

### macOS 权限问题

Collector 需要 Screen Recording 权限：

1. System Settings → Privacy & Security → Screen Recording
2. 添加 Terminal / VS Code / 你的开发工具
3. 重启开发服务
