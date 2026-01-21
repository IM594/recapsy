# TODO

> Last updated: 2026-01-21 23:08
>
> 规则：每完成一项任务，把它从 `In Progress/Next` 移到 `Done`，并更新上面的时间。

## In Progress
- [ ] 统一 UI 文案：确保用户可见内容始终英文（并加简单约束/检查）

## Next
- [ ] 将 UI 文案集中到 constants（可选：为后续 i18n 做准备）

## Done (recent)
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
