# RecapSense macOS App（SwiftUI，骨架）

这是一个 **macOS 13+** 的 SwiftUI 应用骨架（当前以 SwiftPM 可执行程序形式存在），目标是让 RecapSense 逐步从“开发期命令行”走向“用户安装即用”。

当前阶段只做最小可用的外壳：

- 菜单栏（Menu Bar）入口：显示状态、启动/停止采集与本机服务（后续完善）
- 主窗口：搜索（可点开查看 chunk 全文）/日总结/日志/设置（聊天后置，只预留入口）
- Supervisor：统一托管子进程生命周期（Agent/MCP/Collector），并把日志写入数据目录
- 设置页：可调整采集间隔/去重/缩略图/证据保留等（设置存 Agent 的 SQLite `settings` 表）

> 说明：为了先跑通闭环、降低工程复杂度，本目录暂时不做 .app 打包/签名/notarize；后续会补齐发布形态（DMG/PKG + 开机自启 + 自动更新等）。

## 运行（开发）

在仓库根目录执行：

```bash
swift run --package-path apps/app-macos
```

或使用 npm（推荐）：

```bash
npm run dev:app:macos
```

### 启动顺序（推荐）

1. 先编译一次 collector（只需要做一次；之后可复用二进制）：

   ```bash
   swift build -c release --package-path apps/collector-macos
   ```

2. 启动菜单栏应用：

   ```bash
   npm run dev:app:macos
   ```

3. 在菜单栏 RecapSense 中按顺序打开开关：
   - `Agent`
   - `MCP（SSE）`
   - `采集（Collector）`

4. 点击“打开主窗口”，在“搜索”页直接搜索（query 为空表示最近内容）。

## 当前行为（MVP）

- 应用启动后会尝试自动启动：Agent + MCP（SSE）+ Collector（如果你的开发环境 PATH 里有 node）。
- 点击 Dock 图标会打开主窗口（如果主窗口没打开过/已关闭）。
- 日志落盘位置：`${RECAPSENSE_DATA_DIR}/logs/*.log`

### 常见问题：`env: node: No such file or directory`

开发期我们用 `/usr/bin/env node ...` 启动 Agent/MCP，所以需要 `node` 在 PATH 里。

- 先在终端确认：`node -v` 可用
- 然后从同一个终端启动：`npm run dev:app:macos`

> 后续做发布形态（.app/DMG）时，我们会把 Node runtime 内置到应用里或将 Agent/MCP 收敛到原生实现，避免依赖用户的 PATH。

推荐环境变量（可选）：

- `RECAPSENSE_DATA_DIR`：数据目录（默认 `./.recapsense`）
- `RECAPSENSE_AGENT_URL`：Agent 地址（默认 `http://127.0.0.1:4832`）
- `RECAPSENSE_REPO_ROOT`：仓库根目录（默认当前工作目录）
