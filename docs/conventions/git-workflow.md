# Git 工作流规范

> 适用范围：Recaply Sense monorepo 全局

## 1. 分支策略：Trunk-Based Development

### 主分支

- **`main`** — 唯一长期分支，始终保持可构建状态
- 所有变更最终合并到 `main`

### 短命功能分支

小改动（bug fix、文档修改、配置调整）可直接推送 `main`。较大功能使用短命分支：

```
feat/ingestion-pipeline
feat/vector-search
fix/ws-reconnect
refactor/storage-repository
docs/api-contracts
chore/biome-config
```

**规则：**

- 分支生命周期 ≤ 3 天（超过说明需拆分）
- 从 `main` 创建，合并回 `main` 后立即删除
- 每天至少 rebase 一次 `main`（保持最新）

### 分支命名

```
<type>/<short-description>

type := feat | fix | refactor | docs | chore | test | perf
description := 小写英文，单词用连字符分隔，2-4 个词
```

**示例：**

```
feat/screenshot-ingestion     ✅
fix/ocr-text-truncation       ✅
refactor/ai-provider-layer    ✅
feature/add-new-search        ❌ (用 feat 不用 feature)
fix/bug                       ❌ (描述不具体)
feat/Add_Search_Feature       ❌ (不要大写和下划线)
```

---

## 2. Commit Message 格式：Conventional Commits

### 基本格式

```
<type>(<scope>): <subject>

[body]

[footer]
```

### Type 列表

| Type       | 用途                   | 示例                                               |
| ---------- | ---------------------- | -------------------------------------------------- |
| `feat`     | 新功能                 | `feat(search): add vector search strategy`         |
| `fix`      | Bug 修复               | `fix(ingestion): handle null ocr_text in pipeline` |
| `refactor` | 重构（不改变行为）     | `refactor(storage): extract repository interface`  |
| `perf`     | 性能优化               | `perf(search): add embedding batch processing`     |
| `test`     | 测试相关               | `test(agent): add tool calling unit tests`         |
| `docs`     | 文档变更               | `docs(api): update search endpoint contract`       |
| `chore`    | 构建/工具/配置         | `chore(deps): bump hono to 4.x`                    |
| `style`    | 代码格式（不影响逻辑） | `style: apply biome formatting`                    |
| `ci`       | CI/CD 变更             | `ci: add test workflow for engine`                 |

### Scope 列表

Scope 对应项目模块，必须写：

```
# Engine 子模块
api, mcp, ingestion, vision, agent, search, ai, storage

# 其他模块
desktop, collector, shared

# 跨模块
deps, config, build, ci
```

### Subject 规则

- 英文，小写开头，不加句号
- 祈使语气（`add` 不是 `added`/`adds`）
- ≤ 72 字符
- 说明 **做了什么**，不是 **怎么做的**

```
feat(search): add hybrid search combining vector and fulltext   ✅
feat(search): Added new search feature.                         ❌ (过去式+句号)
feat(search): implement hybrid search by combining vector       ❌ (说的是"怎么做")
```

### Body（可选）

- 空一行后写 body
- 解释 **为什么** 做这个改动（what 在 subject 里已说明）
- 每行 ≤ 100 字符

```
feat(vision): add app session detection

Detect app session boundaries by monitoring bundle_id changes.
Sessions flush when user switches apps or after 30min timeout.
This enables TDR-019 two-tier screenshot understanding.
```

### Breaking Changes

```
feat(api)!: change search response format

BREAKING CHANGE: search response now includes activity_segments
field. Clients must handle the new response shape.
```

- Subject 中加 `!` 标记
- Footer 中写 `BREAKING CHANGE:` 详细说明

### 多模块变更

如果一次 commit 涉及多个模块，scope 用逗号分隔或省略：

```
refactor(ingestion,storage): split screenshot save from indexing
refactor: reorganize module dependency structure
```

---

## 3. Commit 粒度

### 原则

- **一个 commit = 一个逻辑变更**
- 每个 commit 应可独立理解、独立 revert
- 避免"大杂烩" commit

### 拆分指引

```
✅ 好的拆分：
  commit 1: feat(storage): add screenshot repository interface
  commit 2: feat(storage): implement surrealdb screenshot repository
  commit 3: feat(ingestion): use screenshot repository in pipeline
  commit 4: test(storage): add screenshot repository tests

❌ 不好的拆分：
  commit 1: feat: add search and fix ingestion bug and update docs
```

### WIP Commit

开发过程中可使用 WIP commit，但合并前必须 squash/rebase 整理：

```
git commit -m "wip: checkpoint search implementation"   # 开发中可以
# 合并前 interactive rebase 整理成规范 commit
```

---

## 4. Code Review（自审/未来协作）

### 当前阶段（个人开发）

- 功能分支合并前，用 `git diff main` 自审一次
- 检查清单：
  - [ ] 是否有调试代码残留（`console.log`、`TODO: remove`）
  - [ ] 类型是否完整（无 `any`、无 `as` 强转滥用）
  - [ ] 错误处理是否覆盖
  - [ ] 是否有对应测试
  - [ ] Commit message 是否规范

### 未来协作阶段

- 功能分支通过 PR 合并
- PR 模板：

```markdown
## What

<!-- 简述做了什么 -->

## Why

<!-- 为什么需要这个改动 -->

## How

<!-- 关键实现思路（非显而易见的部分） -->

## Testing

<!-- 如何验证 -->

- [ ] Unit tests added/updated
- [ ] Manual testing done

## Related

<!-- 关联 issue、TDR、文档 -->
```

---

## 5. Tag 与版本标记

```
v0.1.0      # 首个可用版本
v0.2.0      # 新功能
v0.2.1      # Bug 修复
v1.0.0      # 首个稳定版
```

- 遵循 SemVer（详见 `versioning-release.md`）
- 只在 `main` 上打 tag
- Tag message 包含简要 changelog

---

## 6. .gitignore 规范

```gitignore
# Dependencies
node_modules/
.turbo/

# Build outputs
dist/
*.build/
.swiftpm/

# Runtime data (never提交)
*.sqlite
*.surql
*.zst

# Environment
.env
.env.local
.env.*.local

# IDE
.vscode/settings.json
.idea/
*.xcuserdata/

# OS
.DS_Store
Thumbs.db

# Logs
*.log

# Models (too large)
*.onnx
*.bin

# Test coverage
coverage/
```

---

## 7. Git Hooks（推荐）

使用 `lefthook` 或 `simple-git-hooks`：

```yaml
# .lefthook.yml
pre-commit:
  commands:
    lint:
      run: bun run lint --staged
    type-check:
      run: bun run typecheck

commit-msg:
  commands:
    validate:
      run: npx commitlint --edit {1}
```

**commitlint 配置：**

```javascript
// commitlint.config.js
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [
      2,
      "always",
      [
        "api",
        "mcp",
        "ingestion",
        "vision",
        "agent",
        "search",
        "ai",
        "storage",
        "desktop",
        "collector",
        "shared",
        "deps",
        "config",
        "build",
        "ci",
      ],
    ],
    "subject-case": [2, "always", "lower-case"],
  },
};
```

---

## 8. 常用 Git 操作速查

```bash
# 创建功能分支
git checkout -b feat/screenshot-ingestion

# 开发完成，rebase main
git fetch origin
git rebase origin/main

# 整理 commit（如有 WIP）
git rebase -i origin/main

# 合并回 main（fast-forward）
git checkout main
git merge feat/screenshot-ingestion
git branch -d feat/screenshot-ingestion

# 紧急修复直接在 main
git checkout main
# ... fix ...
git commit -m "fix(api): handle missing collector heartbeat"
git push origin main
```
