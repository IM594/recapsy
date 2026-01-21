# RecapSense macOS App（SwiftUI，骨架）

这是一个 **macOS 13+** 的 SwiftUI 应用骨架（当前以 SwiftPM 可执行程序形式存在），目标是让 RecapSense 逐步从“开发期命令行”走向“用户安装即用”。

当前阶段只做最小可用的外壳：

- 菜单栏（Menu Bar）入口：显示状态、启动/停止采集与本机服务（后续完善）
- 主窗口：先做搜索与日志（聊天后置，只预留入口）
- Supervisor：统一托管子进程生命周期（Agent/MCP/Collector），并把日志写入数据目录

> 说明：为了先跑通闭环、降低工程复杂度，本目录暂时不做 .app 打包/签名/notarize；后续会补齐发布形态（DMG/PKG + 开机自启 + 自动更新等）。

## 运行（开发）

在仓库根目录执行：

```bash
swift run --package-path apps/app-macos
```

推荐环境变量（可选）：

- `RECAPSENSE_DATA_DIR`：数据目录（默认 `./.recapsense`）
- `RECAPSENSE_AGENT_URL`：Agent 地址（默认 `http://127.0.0.1:4832`）
- `RECAPSENSE_REPO_ROOT`：仓库根目录（默认当前工作目录）

