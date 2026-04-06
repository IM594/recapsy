# 依赖管理策略

> 适用范围：monorepo 全局（TypeScript + Swift）

## 1. 包管理器

| 端         | 工具 | Lockfile           |
| ---------- | ---- | ------------------ |
| TypeScript | Bun  | `bun.lock`         |
| Swift      | SPM  | `Package.resolved` |

---

## 2. Lockfile 规则

- **`bun.lock` 和 `Package.resolved` 必须提交到 Git**
- CI 使用 `bun install --frozen-lockfile`（lockfile 不一致则失败）
- 开发者本地 `bun install` 后如 lockfile 有变动，需单独 commit

```bash
# 更新依赖后
bun install
git add bun.lock
git commit -m "chore(deps): update lockfile"
```

---

## 3. 依赖分类

### dependencies vs devDependencies

```jsonc
{
  "dependencies": {
    // 运行时必需
    "hono": "^4.x",
    "surrealdb": "^2",
    "zod": "^4",
    "pino": "^9",
    "ai": "^6", // Vercel AI SDK
  },
  "devDependencies": {
    // 仅开发/构建/测试
    "@biomejs/biome": "^2.x",
    "@types/bun": "latest",
    "pino-pretty": "^13.x", // 仅开发环境日志美化
    "@commitlint/cli": "^20",
  },
}
```

### 规则

- 运行时需要 → `dependencies`
- 构建/测试/开发工具 → `devDependencies`
- 类型包（`@types/*`）→ `devDependencies`
- 不使用 `peerDependencies`（非库项目）

---

## 4. 版本范围策略

| 类型                                    | 策略           | 示例       | 理由                   |
| --------------------------------------- | -------------- | ---------- | ---------------------- |
| **核心依赖**（Hono, SurrealDB, AI SDK） | `^major`       | `"^4"`     | 允许 minor + patch    |
| **工具链**（Biome, commitlint）         | `^major`       | `"^2"`     | 宽松，工具兼容性好     |
| **类型包**                              | `latest`       | `"latest"` | 总是最新               |
| **精确锁定**                            | 仅出问题时     | `"1.2.3"`  | 除非某版本有已知 bug   |

```jsonc
{
  "dependencies": {
    "hono": "^4", // 核心：锁 major
    "zod": "^4", // 核心：锁 major
    "pino": "^9", // 稳定库：锁 major
  },
  "devDependencies": {
    "@biomejs/biome": "^2", // 工具：锁 major
  },
}
```

---

## 5. 依赖更新策略

### 更新频率

| 类型           | 频率 | 方式                                             |
| -------------- | ---- | ------------------------------------------------ |
| **安全补丁**   | 立即 | 手动或 Dependabot 自动 PR                        |
| **Patch 更新** | 每周 | 批量更新                                         |
| **Minor 更新** | 每月 | 逐个验证后更新                                   |
| **Major 更新** | 按需 | 评估 breaking changes 后手动更新，必要时创建 TDR |

### 更新流程

```bash
# 1. 查看可更新依赖
bun outdated

# 2. 更新（patch/minor）
bun update

# 3. 运行完整测试
bun run lint && bun run test

# 4. 如果测试通过，提交
git add bun.lock package.json
git commit -m "chore(deps): update dependencies"

# 5. Major 更新
bun add hono@latest   # 明确指定
# 检查 CHANGELOG，测试，可能需要代码修改
```

### Dependabot 配置

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
    groups:
      dev-dependencies:
        patterns: ["@types/*", "@biomejs/*", "@commitlint/*"]
      ai-sdk:
        patterns: ["ai", "@ai-sdk/*"]
    open-pull-requests-limit: 10
    labels: ["dependencies"]
    commit-message:
      prefix: "chore(deps)"

  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "monthly"
    commit-message:
      prefix: "ci"
```

---

## 6. 漏洞扫描

### 方法

```bash
# Bun 内置审计（检查已知漏洞）
bun audit

# 也可使用
bun pm audit
```

### CI 集成

```yaml
# 在 CI 中添加审计步骤
- name: Security Audit
  run: bun audit
  continue-on-error: true # 警告但不阻塞（避免误报阻塞开发）
```

### 响应策略

| 严重性   | 响应时间     | 动作           |
| -------- | ------------ | -------------- |
| Critical | 24 小时内    | 立即更新或替换 |
| High     | 1 周内       | 优先更新       |
| Medium   | 下次例行更新 | 常规更新       |
| Low      | 评估后决定   | 可延后         |

---

## 7. 新依赖引入规则

### 引入前检查

添加新依赖前，评估以下清单：

| 检查项         | 标准                                    |
| -------------- | --------------------------------------- |
| **必要性**     | 是否能用已有依赖或少量代码替代？        |
| **维护状态**   | 最近 6 个月内有更新？Issues 有响应？    |
| **包体积**     | `bundlephobia.com` 检查，避免巨型依赖   |
| **许可证**     | MIT / Apache-2.0 / BSD（禁止 GPL 污染） |
| **Bun 兼容性** | 是否在 Bun 运行时下正常工作？           |
| **类型支持**   | 内置类型或有 `@types/*` 包？            |
| **安全性**     | 无已知高危漏洞？                        |

### 许可证白名单

```
✅ 允许：MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, Unlicense
⚠️ 需评估：MPL-2.0 (文件级 copyleft)
❌ 禁止：GPL-2.0, GPL-3.0, AGPL-3.0, SSPL (copyleft 会污染整个项目)
```

### 审批流程（当前个人阶段）

1. 评估上述清单
2. 在 commit message 中说明引入原因
3. 核心依赖变更记录 TDR

---

## 8. Monorepo 内部依赖

```jsonc
// packages/engine/package.json
{
  "dependencies": {
    "@recaply/shared": "workspace:*", // 使用 workspace 协议
  },
}
```

**规则：**

- 内部包使用 `workspace:*`（始终使用本地版本）
- 不在内部包之间指定具体版本号
- `packages/shared` 是纯类型/常量包，不引入重量级运行时依赖
