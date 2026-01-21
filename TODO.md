# TODO

> Last updated: 2026-01-21 22:07
>
> 规则：每完成一项任务，把它从 `In Progress/Next` 移到 `Done`，并更新上面的时间。

## In Progress
- [ ] 进一步减少 `any`：把 `SummaryContext`/SSE payload 做更严格的类型收口

## Next
- [ ] 统一日期/月选择器：`GenerationPreview` 与 `JournalSidebar Jump` 复用同一套组件/逻辑

## Done (recent)
- [x] 多年份支持 + 年份切换（后端 `/api/summary/years` + 前端 `YearSwitcher`）
- [x] Daily 多 repo 必须弹 repo 选择（生成弹窗 + Unified Board + Sidebar）
- [x] 前端 API 调用集中到 service 层，抽共享 types（commit: `621ae5b`）
- [x] workflow `status.result` 解析收敛 + Vite env typing + SSE debug 开关（commit: `03458f3`）
- [x] 后端 repos 扫描日志统一使用 `logger`（commit: `7184123`）
- [x] Electron 主进程入口清理：删除重复的 `electron/main.js`
