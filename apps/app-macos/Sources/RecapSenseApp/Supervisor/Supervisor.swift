import Foundation
import Combine

/// Supervisor 负责托管本机各个子进程（Agent / MCP / Collector）的生命周期。
///
/// 设计目标：
/// - 让 UI “只关心状态与开关”，把进程细节收敛到一处；
/// - 把所有日志落在 `${RECAPSENSE_DATA_DIR}/logs/`，便于排障与未来做“主窗口日志页”。
@MainActor
final class Supervisor: ObservableObject {
  let agent = ManagedProcess(name: "agent")
  let mcp = ManagedProcess(name: "mcp-sse")
  let collector = ManagedProcess(name: "collector")

  @Published var config = SupervisorConfig.loadFromEnvironment()

  private var cancellables: Set<AnyCancellable> = []

  init() {
    // 把子进程对象的变更（state/logFile/lastErrorMessage）透传给 Supervisor，
    // 避免在 View 里再额外拆 @ObservedObject。
    [agent, mcp, collector].forEach { process in
      process.objectWillChange
        .sink { [weak self] _ in
          self?.objectWillChange.send()
        }
        .store(in: &cancellables)
    }
  }

  func startAgent() {
    let spec = ProcessSpec(
      label: "agent",
      executable: "/usr/bin/env",
      arguments: ["node", "apps/agent/src/server.mjs"],
      workingDirectory: config.repoRoot.path,
      environment: config.baseEnvironment.merging([
        // 默认同时开启 TCP + UDS（collector 走 TCP；mcp 可选走 UDS）。
        "RECAPSENSE_AGENT_SOCKET": config.agentSocketEnabled ? "1" : "",
      ]) { _, new in new }
    )

    agent.start(spec: spec, logsDirectory: config.logsDir)
  }

  func stopAgent() {
    agent.stop()
  }

  func startMcpSse() {
    if !agent.state.isRunning {
      // MCP 需要 token/Agent 可用，开发期先做一个“傻瓜化”兜底：启动 MCP 时自动拉起 Agent。
      startAgent()
    }

    let spec = ProcessSpec(
      label: "mcp-sse",
      executable: "/usr/bin/env",
      arguments: ["node", "apps/mcp/src/server-sse.mjs"],
      workingDirectory: config.repoRoot.path,
      environment: config.baseEnvironment.merging([
        "RECAPSENSE_AGENT_SOCKET": config.agentSocketEnabled ? "1" : "",
      ]) { _, new in new }
    )

    mcp.start(spec: spec, logsDirectory: config.logsDir)
  }

  func stopMcpSse() {
    mcp.stop()
  }

  func startCollector() {
    if !agent.state.isRunning {
      // Collector 需要写入 Agent。开发期体验：用户只要点“开始采集”，Agent 会被自动拉起。
      startAgent()
    }

    // 说明：当前先假设 collector 二进制已构建完成（开发期可用 `npm run dev:collector` 或手动 swift build）。
    // 后续会把“自动构建/内置 helper”变成发布形态的一部分。
    let binaryPath = config.collectorBinary.path
    let spec = ProcessSpec(
      label: "collector",
      executable: binaryPath,
      arguments: [
        "--interval",
        String(config.collectorIntervalSeconds),
      ],
      workingDirectory: config.repoRoot.path,
      environment: config.baseEnvironment,
      requiresExecutableOnDisk: true
    )

    collector.start(spec: spec, logsDirectory: config.logsDir)
  }

  func stopCollector() {
    collector.stop()
  }

  func stopAll() {
    collector.stop()
    mcp.stop()
    agent.stop()
  }
}
