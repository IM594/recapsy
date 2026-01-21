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
  @Published private(set) var settings: RecapSenseSettings = .defaults

  private var cancellables: Set<AnyCancellable> = []
  private var hasAutoStarted = false

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

    // 约定：当前版本默认“启动后端 + 启动采集”，让安装后体验尽量接近“开箱即用”。
    autoStartAllIfNeeded()
  }

  func autoStartAllIfNeeded() {
    guard !hasAutoStarted else { return }
    hasAutoStarted = true

    Task {
      startAgent()
      let ok = await waitForAgentHealthy(timeoutSeconds: 10)
      if ok {
        try? await refreshSettingsFromAgent()
        startMcpSse()
        startCollector()
      } else {
        // Agent 启动失败/过慢：仍然让 UI 可用，用户可以手动重试。
      }
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

    var args: [String] = [
      "--interval",
      String(settings.collector.intervalSeconds),
      "--dedupe-threshold",
      String(settings.collector.dedupeThreshold),
      "--ocr-level",
      settings.collector.ocrLevel,
      "--ocr-lang",
      settings.collector.ocrLanguages.joined(separator: ","),
      "--thumbnail-width",
      String(settings.collector.thumbnailMaxWidth),
    ]

    if !settings.collector.thumbnailEnabled {
      args.append("--no-thumbnails")
    }

    let spec = ProcessSpec(
      label: "collector",
      executable: binaryPath,
      arguments: args,
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

  func refreshSettingsFromAgent() async throws {
    // 这里不强制要求 agent state 为 running：
    // - 允许 UI 里用户先点“刷新”，如果 agent 没开，会得到更直观的错误。
    let client = try AgentHttpClient()
    let loaded = try await client.getSettings()
    settings = loaded
  }

  func saveSettingsAndApply(_ newSettings: RecapSenseSettings) async throws {
    let client = try AgentHttpClient()
    let saved = try await client.patchSettings(newSettings)
    settings = saved

    // 应用到 collector：最简单的方式是重启（collector 是独立进程，不做热更新）。
    if collector.state.isRunning {
      await restartCollector()
    }
  }

  private func restartCollector() async {
    stopCollector()

    // 等待进程退出（避免 start() 因 process!=nil 而被忽略）
    let deadline = Date().addingTimeInterval(5)
    while collector.state.isRunning, Date() < deadline {
      try? await Task.sleep(nanoseconds: 100_000_000)
    }

    startCollector()
  }

  private func waitForAgentHealthy(timeoutSeconds: Double) async -> Bool {
    let start = Date()
    let healthUrl = config.agentUrl.appendingPathComponent("/health")

    while Date().timeIntervalSince(start) < timeoutSeconds {
      do {
        let (data, response) = try await URLSession.shared.data(from: healthUrl)
        if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
          // 兼容：即便 body 不是 json，也不影响我们判断 agent 已起来。
          _ = data
          return true
        }
      } catch {
        // 忽略，继续重试
      }

      try? await Task.sleep(nanoseconds: 200_000_000)
    }

    return false
  }
}
