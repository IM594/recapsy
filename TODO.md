# TODO

> Last updated: 2026-01-22 18:53
>
> 使用规则：
> - 每完成一项任务，把它从 `In Progress/Next` 移到 `Done`，并更新上面的时间。
> - 所有重构/改动都必须符合下面的“一致性执行口径”（DRY、常量集中、生命周期对称、错误不吞、架构边界）。

## 一致性执行口径（必须遵守）
- **DRY（唯一来源）**：同一业务逻辑/规则只能有一个实现与一个入口；复用必须通过公共函数、hook、service 或共享模块完成；禁止复制粘贴形成“多份真相”。
- **命名与常量**：命名必须表达意图、可检索；禁止 magic number / magic string；常量、枚举、配置、key、事件名必须集中定义；业务逻辑不得散落在 UI/各处。
- **状态对称与资源生命周期**：任何“开启”必须有对应“关闭”；订阅/定时器/连接/监听必须 cleanup；副作用要成对出现且创建点与销毁点可追踪。
- **错误不吞**：所有 `catch` 必须处理或记录日志（带上下文）；禁止空 `catch`、禁止忽略 Promise rejection；降级/重试/上报必须显式实现。
- **架构边界**：UI 组件只负责渲染与最少交互胶水；业务逻辑必须下沉到 hook/service（或 domain 层）；尽量减少 props drilling，保持数据流清晰。

## In Progress（P0，一致性优先）
- [ ] C-003 常量集中（shared 包）：统一并集中 API mounts/paths、SSE 事件名、storage keys、error codes；继续清理散落 magic string（尤其是 query keys / event names / config keys）

## Next（P0）
- [ ] C-002 Electron prod 冒烟：`pnpm build:app` 后验证后端可启动、UI 可用、输出目录可写（记录步骤与预期）
- [ ] C-004 生命周期审计：梳理全局订阅/轮询/SSE/进程/窗口事件，确保创建与销毁成对且可追踪

## Deferred（按你要求：语言相关暂缓）
- [ ] L-001 增加回归检查：避免新增硬编码 UI 文案（可选）
- [ ] L-002 为 i18n 设计 `t()`/语言包结构（en 先行）

## Done (recent)
- [x] B-001 后端一致性收尾：收敛 `backend/src/lib/git.ts` 的日志与错误处理（移除 `console.*`、禁止空 `catch`），并明确允许降级的错误（`git fetch` / 单 commit stats/diff 失败）
- [x] C-007 输出目录单一真相：统一读写 `userData/outputs`，并提供 `scripts/migrate-outputs.cjs` 迁移历史 `backend/outputs`（避免“多份真相”导致数据看似丢失）
- [x] C-005 错误处理基线（后端）：增加 requestId、统一 async handler + error middleware（兼容旧 `{ error: string }`），并为关键链路补齐上下文日志（routes / SummaryStore / WorkflowRunner）
- [x] SummaryStore 自愈：`index.json` 缺失/损坏时从磁盘重建，降低“数据看起来丢失”的概率
- [x] 引入 `shared/` 工作区包：作为跨端常量/协议的唯一来源（为 C-003 打底）
- [x] C-001 配置唯一入口：新增后端 `backend/src/config/` 作为唯一入口；统一 `.env`/`config.json`/env 注入优先级，并替换关键散落读取点（port/rootPath/includeStat/outputDir）
- [x] Electron dev 冒烟通过：`pnpm dev` 启动后 UI/接口正常（本机确认）
- [x] 修复 Electron 模块解析：CommonJS `require()` 显式使用 `.cjs` 后缀（避免 `Cannot find module './config'`）
- [x] 输出目录一致性：通过 `RECAPLY_OUTPUT_DIR` 统一 backend 落盘路径（避免 prod 写入不可写目录）
- [x] Electron 运行冒烟：`pnpm dev` 启动后确认 UI/接口正常（需要本机 GUI）
- [x] 统一 Electron：拆分模块（config/logger/backend/window/preload）+ 收敛启动/退出流程
- [x] Electron 一致性重构：新增 `electron/config.cjs` / `electron/logger.cjs` / `electron/backend.cjs` / `electron/window.cjs` / `electron/preload.cjs`
- [x] Electron 安全默认：`nodeIntegration=false` + `contextIsolation=true`，并通过 preload 暴露最小运行时信息（如 `homeDir`）
- [x] 统一 UI 文案：用户可见文案集中到 `frontend/src/constants/copy.ts` 并保持英文
- [x] 将 UI 文案集中到 constants（为后续 i18n 做准备）
- [x] 多年份支持 + 年份切换（后端 `/api/summary/years` + 前端 `YearSwitcher`）
- [x] Daily 多 repo 必须弹 repo 选择（生成弹窗 + Unified Board + Sidebar）
- [x] 前端 API 调用集中到 service 层，抽共享 types（commit: `621ae5b`）
- [x] workflow `status.result` 解析收敛 + Vite env typing + SSE debug 开关（commit: `03458f3`）
- [x] 后端 repos 扫描日志统一使用 `logger`（commit: `7184123`）
- [x] Electron 主进程入口清理：删除重复的 `electron/main.js`
- [x] `SummaryContext` SSE payload 去 `any` + 类型化解析
- [x] 日期/月选择器复用：抽 `YearCalendar` + `MonthSelect`，并在两处复用
- [x] Electron 主进程日志与注释风格统一（`electron/main.cjs`）
- [x] 后端日志统一为英文 + 降噪（`backend/src/api/server.ts`, `backend/src/lib/logger.ts`）
