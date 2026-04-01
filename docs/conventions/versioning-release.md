# 版本发布策略

> 适用范围：Recaply Sense 整体应用（monorepo 统一版本）

## 1. 版本号规则：SemVer

```
MAJOR.MINOR.PATCH

0.x.y  — 早期开发阶段（当前）
1.0.0  — 首个稳定版发布
```

| 变更类型              | 版本号 | 示例          |
| --------------------- | ------ | ------------- |
| 向后不兼容的 API 变更 | MAJOR  | 1.0.0 → 2.0.0 |
| 向后兼容的新功能      | MINOR  | 1.0.0 → 1.1.0 |
| 向后兼容的 Bug 修复   | PATCH  | 1.0.0 → 1.0.1 |

### 0.x 阶段特殊规则

在 1.0.0 之前（当前阶段）：

- `0.MINOR.0` = 新功能里程碑
- `0.x.PATCH` = Bug 修复
- 允许 MINOR 版本间有 breaking changes（无需 MAJOR bump）

### 版本里程碑规划

```
v0.1.0  — 核心摄入管线 + 基础搜索
v0.2.0  — AI Agent 对话 + Vision LLM
v0.3.0  — MCP Server + 实体图谱
v0.4.0  — 完整 UI + 设置面板
v0.5.0  — 备份/导出 + 性能优化
v0.9.0  — Beta 公测
v1.0.0  — 首个稳定版
```

---

## 2. 统一版本（Monorepo 策略）

整个应用使用**统一版本号**（不是每个包独立版本）：

```jsonc
// 根 package.json
{ "version": "0.1.0" }

// packages/engine/package.json
{ "version": "0.1.0" }

// packages/shared/package.json
{ "version": "0.1.0" }
```

**理由：**

- 单一桌面应用（非多包分发到 npm），统一版本最简单
- Collector + Engine + Desktop 同一个 app bundle，版本必须一致
- 避免包间版本兼容矩阵的复杂度

---

## 3. 发布流程

### 3.1 准备发布

```bash
# 1. 确保 main 分支 CI 通过
# 2. 更新版本号
bun run version:bump 0.2.0   # 或手动修改 package.json

# 3. 生成/更新 Changelog
bunx changelogen --release 0.2.0

# 4. 提交版本变更
git add -A
git commit -m "chore(release): v0.2.0"

# 5. 打 tag
git tag -a v0.2.0 -m "Release v0.2.0

- feat(search): hybrid search combining vector and fulltext
- feat(vision): app session detection and activity segments
- fix(ingestion): handle null ocr_text correctly
"

# 6. 推送
git push origin main --tags
```

### 3.2 构建产物

```bash
# 触发 release workflow（手动或 tag push）
# 产物：
#   RecaplySense-0.2.0.dmg          (macOS installer)
#   RecaplySense-0.2.0.dmg.sha256   (checksum)
```

### 3.3 发布渠道

| 渠道     | 说明   | Tag 格式        |
| -------- | ------ | --------------- |
| `stable` | 正式版 | `v0.2.0`        |
| `beta`   | 测试版 | `v0.2.0-beta.1` |

---

## 4. Changelog 规范

### 格式

遵循 [Keep a Changelog](https://keepachangelog.com/)（详见 `documentation-standards.md`）：

```markdown
# Changelog

## [0.2.0] - 2026-05-15

### Added

- feat(search): hybrid search combining vector and fulltext (#12)
- feat(vision): app session detection and activity segments (#18)
- feat(mcp): MCP server with stdio and HTTP transport (#22)

### Fixed

- fix(ingestion): handle null ocr_text in pipeline (#15)
- fix(api): correct WebSocket reconnection logic (#20)

### Changed

- refactor(storage): extract repository interface (#18)
- perf(search): batch embedding processing 20x speedup (#25)

### Removed

- removed deprecated `/api/v1/search/basic` endpoint

## [0.1.0] - 2026-04-15

### Added

- Initial screenshot ingestion pipeline
- ...
```

### 自动生成

Conventional Commits 格式使 changelog 可自动化：

```bash
# 生成自上次 tag 以来的 changelog
bunx changelogen

# 生成指定版本
bunx changelogen --release 0.2.0
```

Commit type → Changelog section 映射：
| Commit Type | Changelog Section |
|-------------|------------------|
| `feat` | Added |
| `fix` | Fixed |
| `refactor`, `perf` | Changed |
| `docs` | 不记入（除非重大文档变更） |
| `chore`, `ci`, `test` | 不记入 |
| `BREAKING CHANGE` | ⚠️ Breaking Changes（置顶） |

---

## 5. GitHub Release

每次打 tag 后创建 GitHub Release：

```markdown
## Recaply Sense v0.2.0

### Highlights

- 🔍 **Hybrid Search**: Vector + fulltext fusion for better recall
- 🧠 **Vision LLM**: Automatic activity summaries by app session

### Downloads

- [RecaplySense-0.2.0.dmg](link) (macOS 13+)
- SHA256: `abc123...`

### Full Changelog

See [CHANGELOG.md](link) for complete details.

### System Requirements

- macOS 13 Ventura or later
- 4GB RAM minimum (8GB recommended)
- 500MB disk space (plus screenshot storage)
```

---

## 6. 版本号在代码中

```typescript
// packages/shared/src/constants/version.ts
// This is auto-updated by the version bump script
export const VERSION = "0.2.0";
```

```typescript
// 在 health API 中暴露
// GET /api/v1/health
{
  "status": "ok",
  "version": "0.2.0",
  // ...
}
```

---

## 7. 版本回滚

```bash
# 回滚到上一个版本
git revert <release-commit>
git tag -a v0.2.1 -m "Revert: rollback to v0.1.0 state"
# 重新构建并发布 v0.2.1
```

**不要删除已发布的 tag**。出问题时发新版本修复，不回退 tag。
