import Foundation
import Combine
import Darwin

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
  @Published private(set) var collectorPauseState: CollectorPauseState = .none
  @Published var collectorEnabled: Bool = true
  @Published private(set) var collectorDiagnostics = CollectorProcessDiagnostics()

  private var cancellables: Set<AnyCancellable> = []
  private var hasAutoStarted = false
  private var collectorResumeTask: Task<Void, Never>? = nil
  private var agentStartTask: Task<Void, Never>? = nil
  private var mcpStartTask: Task<Void, Never>? = nil
  private var collectorDiagnosticsTask: Task<Void, Never>? = nil
  private var collectorAutoRestartTask: Task<Void, Never>? = nil
  private var collectorStabilityTask: Task<Void, Never>? = nil
  private var collectorAutoRestartSuppressed = false
  private var collectorAutoRestartAttempt = 0
  private var collectorFixTask: Task<Void, Never>? = nil
  private var collectorAutoRestartToken: UUID? = nil

  init(autoStart: Bool = true) {
    // 把子进程对象的变更（state/logFile/lastErrorMessage）透传给 Supervisor，
    // 避免在 View 里再额外拆 @ObservedObject。
    [agent, mcp, collector].forEach { process in
      process.objectWillChange
        .sink { [weak self] _ in
          self?.objectWillChange.send()
        }
        .store(in: &cancellables)
    }

    collector.$state
      .sink { [weak self] _ in
        self?.handleCollectorStateChange()
      }
      .store(in: &cancellables)

    startCollectorDiagnosticsLoop()

    if autoStart {
      // 约定：当前版本默认“启动后端 + 启动采集”，让安装后体验尽量接近“开箱即用”。
      autoStartAllIfNeeded()
    }
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

  private func startCollectorDiagnosticsLoop() {
    collectorDiagnosticsTask?.cancel()
    collectorDiagnosticsTask = Task { @MainActor in
      while !Task.isCancelled {
        refreshCollectorDiagnosticsNow()
        ensureCollectorProcessIntent()
        try? await Task.sleep(nanoseconds: 2_000_000_000)
      }
    }
  }

  private func refreshCollectorDiagnosticsNow() {
    let managedPid: Int32?
    if case .running(let pid) = collector.state {
      managedPid = pid
    } else {
      managedPid = nil
    }

    let lockFile = config.dataDir.appendingPathComponent("run/collector.lock")
    let lockPid = ProcessInspector.readPidFromLockFile(lockFile)
    let processes = ProcessInspector.collectorProcesses(repoRoot: config.repoRoot, dataDir: config.dataDir)

    collectorDiagnostics.lastScanAt = Date()
    collectorDiagnostics.managedPid = managedPid
    collectorDiagnostics.lockPid = lockPid
    collectorDiagnostics.processes = processes
  }

  private func handleCollectorStateChange() {
    refreshCollectorDiagnosticsNow()

    switch collector.state {
    case .running(let pid):
      collectorAutoRestartTask?.cancel()
      collectorAutoRestartTask = nil
      collectorDiagnostics.autoRestarting = false
      collectorDiagnostics.nextAutoRestartAt = nil
      scheduleCollectorStabilityReset(pid: pid)
    case .stopped, .exited, .failed:
      if shouldAutoRestartCollector() {
        scheduleCollectorAutoRestart()
      } else {
        collectorAutoRestartTask?.cancel()
        collectorAutoRestartTask = nil
        collectorDiagnostics.autoRestarting = false
        collectorDiagnostics.nextAutoRestartAt = nil
      }
    case .starting, .runningExternal:
      break
    }
  }

  private func shouldAutoRestartCollector() -> Bool {
    if collectorAutoRestartSuppressed { return false }
    if !collectorEnabled { return false }
    if collectorPauseState != .none { return false }
    return true
  }

  private func scheduleCollectorAutoRestart() {
    collectorAutoRestartTask?.cancel()

    collectorAutoRestartAttempt += 1
    let backoffSeconds = min(60.0, pow(2.0, Double(max(0, collectorAutoRestartAttempt - 1))))

    let token = UUID()
    collectorAutoRestartToken = token
    collectorDiagnostics.autoRestarting = true
    collectorDiagnostics.autoRestartAttempt = collectorAutoRestartAttempt
    collectorDiagnostics.nextAutoRestartAt = Date().addingTimeInterval(backoffSeconds)

    collectorAutoRestartTask = Task { @MainActor in
      defer {
        // 如果任务自然结束且没被新的重启任务替换，清空引用，允许后续重新安排。
        if self.collectorAutoRestartToken == token {
          self.collectorAutoRestartTask = nil
          self.collectorAutoRestartToken = nil
        }
      }

      let ns = UInt64(backoffSeconds * 1_000_000_000)
      try? await Task.sleep(nanoseconds: ns)
      if Task.isCancelled { return }

      collectorDiagnostics.autoRestarting = false
      collectorDiagnostics.nextAutoRestartAt = nil

      guard shouldAutoRestartCollector() else { return }
      guard !collector.state.isRunning else { return }

      startCollector()
    }
  }

  private func scheduleCollectorStabilityReset(pid: Int32) {
    collectorStabilityTask?.cancel()
    collectorStabilityTask = Task { @MainActor in
      try? await Task.sleep(nanoseconds: 30_000_000_000)
      if Task.isCancelled { return }
      guard collector.state == .running(pid: pid) else { return }

      collectorAutoRestartAttempt = 0
      collectorDiagnostics.autoRestartAttempt = 0
      collectorDiagnostics.nextAutoRestartAt = nil
    }
  }

  private func ensureCollectorProcessIntent() {
    // 语义：
    // - collectorEnabled=false：用户期望“完全不采集”（即便有外部 collector，也应被视为异常）。
    // - collectorPauseState!=none：用户期望“暂时不采集”（应确保没有 collector 在跑）。
    // - enabled 且未暂停：只允许 1 个 collector 实例（否则会导致黑名单/日志错乱）。
    guard collectorFixTask == nil else { return }

    let shouldHaveNoCollector = (!collectorEnabled) || (collectorPauseState != .none)
    if shouldHaveNoCollector {
      let processes = collectorDiagnostics.processes
      if processes.isEmpty { return }
      let pids = processes.map(\.pid)
      collectorFixTask = Task { @MainActor in
        defer { collectorFixTask = nil }
        collectorDiagnostics.autoFixing = true
        defer { collectorDiagnostics.autoFixing = false }

        for pid in pids {
          _ = await ProcessInspector.terminate(pid: pid)
        }

        collectorDiagnostics.lastAutoFixAt = Date()
        collectorDiagnostics.lastAutoFixMessage = "采集未启用/已暂停：已停止检测到的后台 collector"
        refreshCollectorDiagnosticsNow()
      }
      return
    }

    // enabled 且未暂停：如果 collector 已经消失（进程不存在 + state 非 running），安排自动恢复。
    // 说明：这里是“兜底”，避免某些极端情况下 state 回调没触发，导致无法自愈。
    if !collector.state.isRunning {
      if case .starting = collector.state {
        // 正在启动：不干预
      } else {
        let processes = collectorDiagnostics.processes
        if processes.isEmpty, shouldAutoRestartCollector(), collectorAutoRestartTask == nil {
          scheduleCollectorAutoRestart()
          return
        }
      }
    }

    // enabled 且未暂停：确保只有一个 collector，并优先保留“本 App 托管”的实例。
    let processes = collectorDiagnostics.processes
    if processes.isEmpty { return }
    let managedPid = collectorDiagnostics.managedPid
    let runningPids = Set(processes.map(\.pid))
    let hasManaged: Bool = {
      guard let managedPid else { return false }
      guard runningPids.contains(managedPid) else { return false }
      return ProcessInspector.isPidAlive(managedPid)
    }()

    // 已经是“单实例 + 托管实例”时，不做任何事。
    if hasManaged, processes.count <= 1 { return }

    collectorFixTask = Task { @MainActor in
      defer { collectorFixTask = nil }
      collectorDiagnostics.autoFixing = true
      defer { collectorDiagnostics.autoFixing = false }

      if hasManaged, let managedPid {
        for pid in processes.map(\.pid) where pid != managedPid {
          _ = await ProcessInspector.terminate(pid: pid)
        }
        collectorDiagnostics.lastAutoFixAt = Date()
        collectorDiagnostics.lastAutoFixMessage = "检测到多个实例：已保留本 App 托管的 collector，并停止其余实例"
        refreshCollectorDiagnosticsNow()
        return
      }

      // 没有可保留的托管实例：先清空，再由 Supervisor 拉起一个“可控实例”。
      for pid in processes.map(\.pid) {
        _ = await ProcessInspector.terminate(pid: pid)
      }

      collectorDiagnostics.lastAutoFixAt = Date()
      collectorDiagnostics.lastAutoFixMessage = "检测到外部/多实例：已停止现有 collector，准备拉起一个新 collector"
      refreshCollectorDiagnosticsNow()

      if shouldAutoRestartCollector() && !collector.state.isRunning {
        startCollector()
      }
    }
  }

  func startAgent() {
    guard !agent.state.isRunning else { return }
    guard agentStartTask == nil else { return }

    agentStartTask = Task { @MainActor in
      defer { agentStartTask = nil }

      // 先用 /health 探测：避免重复启动第二个 Agent（多实例写同一 DB 风险很高）。
      let healthUrl = config.agentUrl.appendingPathComponent("health")
      let existing = await probeHealth(url: healthUrl, timeoutSeconds: 0.35)
      if existing.ok {
        if existing.service == nil || existing.service == "recapsense-agent" {
          agent.markExternalRunning(logFile: config.logsDir.appendingPathComponent("agent.log"))
          return
        }
        agent.markFailed(message: "Agent 端口已被占用：\(existing.service ?? "unknown")")
        return
      }

      let spec = ProcessSpec(
        label: "agent",
        executable: config.node.executable,
        arguments: config.node.argumentsPrefix + ["apps/agent/src/server.mjs"],
        workingDirectory: config.repoRoot.path,
        environment: config.baseEnvironment.merging([
          // 默认同时开启 TCP + UDS（collector 走 TCP；mcp 可选走 UDS）。
          "RECAPSENSE_AGENT_SOCKET": config.agentSocketEnabled ? "1" : "",
          // 避免“非正常退出”导致子进程残留占用端口。
          "RECAPSENSE_PARENT_PID": String(getpid()),
        ]) { _, new in new }
      )

      agent.start(spec: spec, logsDirectory: config.logsDir)
    }
  }

  func stopAgent() {
    if case .runningExternal = agent.state {
      Task { @MainActor in
        do {
          let client = try AgentHttpClient()
          try await client.shutdown()
          _ = await waitForAgentGone(timeoutSeconds: 2.0)
          agent.markStoppedIfExternal()
        } catch {
          agent.markFailed(message: "无法关闭外部 Agent：\(String(describing: error))")
        }
      }
      return
    }

    agent.stop()
  }

  func startMcpSse() {
    guard !mcp.state.isRunning else { return }
    guard mcpStartTask == nil else { return }

    mcpStartTask = Task { @MainActor in
      defer { mcpStartTask = nil }

      // 先探测 4833：避免异常退出时端口残留，导致再次启动直接 EADDRINUSE。
      let healthUrl = config.mcpUrl.appendingPathComponent("health")
      let existing = await probeHealth(url: healthUrl, timeoutSeconds: 0.35)
      if existing.ok {
        if existing.service == nil || existing.service == "recapsense-mcp-sse" {
          mcp.markExternalRunning(logFile: config.logsDir.appendingPathComponent("mcp-sse.log"))
          return
        }
        mcp.markFailed(message: "MCP 端口已被占用：\(existing.service ?? "unknown")")
        return
      }

      if !agent.state.isRunning {
        // MCP 需要 token/Agent 可用，开发期先做一个“傻瓜化”兜底：启动 MCP 时自动拉起 Agent。
        startAgent()
      }

      let spec = ProcessSpec(
        label: "mcp-sse",
        executable: config.node.executable,
        arguments: config.node.argumentsPrefix + ["apps/mcp/src/server-sse.mjs"],
        workingDirectory: config.repoRoot.path,
        environment: config.baseEnvironment.merging([
          "RECAPSENSE_AGENT_SOCKET": config.agentSocketEnabled ? "1" : "",
          "RECAPSENSE_PARENT_PID": String(getpid()),
        ]) { _, new in new }
      )

      mcp.start(spec: spec, logsDirectory: config.logsDir)
    }
  }

  func stopMcpSse() {
    if case .runningExternal = mcp.state {
      Task { @MainActor in
        do {
          try await shutdownMcpSse()
          mcp.markStoppedIfExternal()
        } catch {
          mcp.markFailed(message: "无法关闭外部 MCP：\(String(describing: error))")
        }
      }
      return
    }

    mcp.stop()
  }

  func startCollector() {
    guard collectorEnabled else { return }
    // 如果用户处于“暂停”状态，就不自动拉起采集（避免出现“我刚暂停怎么又起来了”）。
    guard collectorPauseState == .none else { return }

    if !agent.state.isRunning {
      // Collector 需要写入 Agent。开发期体验：用户只要点“开始采集”，Agent 会被自动拉起。
      startAgent()
    }

    // 说明：
    // - 开发期 collector 先由 SwiftPM 构建（`apps/collector-macos/.build/...`）
    // - 但为了让“屏幕录制”权限更稳定，我们优先把它复制到 `${DATA_DIR}/bin/` 再运行。
    let binaryPath = ensureCollectorInstalled()

    var args: [String] = [
      "--interval",
      String(settings.collector.intervalSeconds),
      "--dedupe-threshold",
      String(settings.collector.dedupeThreshold),
      "--ocr-level",
      settings.collector.ocrLevel,
      // 先默认开启 OCR 全文调试日志：用户可以在“日志”页一键复制发来排障。
      // 注意：这是高隐私/高体量日志（带轮转），后续可在设置里做开关。
      "--ocr-log",
      "--ocr-lang",
      settings.collector.ocrLanguages.joined(separator: ","),
      "--thumbnail-width",
      String(settings.collector.thumbnailMaxWidth),
    ]

    for appName in settings.collector.excludedApps {
      let trimmed = appName.trimmingCharacters(in: .whitespacesAndNewlines)
      if trimmed.isEmpty { continue }
      args.append("--exclude-app")
      args.append(trimmed)
    }

    if !settings.collector.thumbnailEnabled {
      args.append("--no-thumbnails")
    }

    let spec = ProcessSpec(
      label: "collector",
      executable: binaryPath,
      arguments: args,
      workingDirectory: config.repoRoot.path,
      environment: config.baseEnvironment.merging([
        // 让 collector 的错误提示更精确：知道自己是被菜单栏 App 拉起的（而不是用户手动在终端跑）。
        "RECAPSENSE_LAUNCH_SOURCE": "app-macos",
        // 让 collector 在父进程消失时能自动退出（避免后台悬挂）。
        "RECAPSENSE_PARENT_PID": String(getpid()),
      ]) { _, new in new },
      requiresExecutableOnDisk: true
    )

    collector.start(spec: spec, logsDirectory: config.logsDir)
  }

  func stopCollector() {
    collector.stop()
  }

  func stopCollectorFully() {
    collectorEnabled = false
    collectorPauseState = .none
    collectorResumeTask?.cancel()
    collectorResumeTask = nil
    collectorAutoRestartTask?.cancel()
    collectorAutoRestartTask = nil
    collectorDiagnostics.autoRestarting = false
    collectorDiagnostics.nextAutoRestartAt = nil
    collectorAutoRestartAttempt = 0
    collectorDiagnostics.autoRestartAttempt = 0
    stopCollector()
  }

  func pauseCollectorManually() {
    collectorEnabled = true
    collectorPauseState = .manual
    collectorResumeTask?.cancel()
    collectorResumeTask = nil
    stopCollector()
  }

  func pauseCollector(forSeconds seconds: Double) {
    collectorEnabled = true
    let until = Date().addingTimeInterval(max(1, seconds))
    collectorPauseState = .until(until)
    collectorResumeTask?.cancel()
    collectorResumeTask = nil
    stopCollector()

    collectorResumeTask = Task { @MainActor in
      // 每 0.5s 轮询一次，便于 UI 显示“剩余时间”时可实时更新（未来可优化为定时器）。
      while true {
        if Task.isCancelled { return }
        guard case .until(let pauseUntil) = collectorPauseState else { return }
        if Date() >= pauseUntil {
          collectorPauseState = .none
          startCollector()
          return
        }
        try? await Task.sleep(nanoseconds: 500_000_000)
      }
    }
  }

  func resumeCollector() {
    collectorEnabled = true
    collectorAutoRestartSuppressed = false
    collectorPauseState = .none
    collectorResumeTask?.cancel()
    collectorResumeTask = nil
    collectorAutoRestartTask?.cancel()
    collectorAutoRestartTask = nil
    collectorDiagnostics.autoRestarting = false
    collectorDiagnostics.nextAutoRestartAt = nil
    collectorAutoRestartAttempt = 0
    collectorDiagnostics.autoRestartAttempt = 0
    startCollector()
  }

  func stopAll() {
    collectorEnabled = false
    collectorAutoRestartSuppressed = true
    collectorAutoRestartTask?.cancel()
    collectorAutoRestartTask = nil
    collectorDiagnostics.autoRestarting = false
    collectorDiagnostics.nextAutoRestartAt = nil
    collectorResumeTask?.cancel()
    collectorResumeTask = nil
    collector.stop()
    mcp.stop()
    agent.stop()
  }

  func stopAllAndWait(timeoutSeconds: Double = 4) async {
    stopAll()
    await waitUntilAllStopped(timeoutSeconds: timeoutSeconds)
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
    if collectorEnabled && collectorPauseState == .none {
      await restartCollector()
    }
  }

  func dangerDelete(scope: String) async throws -> DangerDeleteResult {
    let shouldResume = (collectorEnabled && collectorPauseState == .none)

    collectorAutoRestartSuppressed = true
    collectorAutoRestartTask?.cancel()
    collectorAutoRestartTask = nil
    defer { collectorAutoRestartSuppressed = false }
    stopCollector()

    let client = try AgentHttpClient()
    let result = try await client.dangerDelete(scope: scope)

    // 删除可能影响“最近搜索/日总结”：刷新一下 settings（顺便验证 agent 仍可用）。
    // 失败不影响主流程。
    try? await refreshSettingsFromAgent()

    if shouldResume {
      collectorAutoRestartSuppressed = false
      startCollector()
    }

    return result
  }

  private func restartCollector() async {
    let shouldStartAfter = (collectorEnabled && collectorPauseState == .none)

    collectorAutoRestartSuppressed = true
    defer { collectorAutoRestartSuppressed = false }
    collectorAutoRestartTask?.cancel()
    collectorAutoRestartTask = nil
    collectorDiagnostics.autoRestarting = false
    collectorDiagnostics.nextAutoRestartAt = nil

    stopCollector()

    // 等待进程退出（避免 start() 因 process!=nil 而被忽略）
    let deadline = Date().addingTimeInterval(5)
    while collector.state.isRunning, Date() < deadline {
      try? await Task.sleep(nanoseconds: 100_000_000)
    }

    if shouldStartAfter {
      collectorAutoRestartSuppressed = false
      startCollector()
    }
  }

  private func waitUntilAllStopped(timeoutSeconds: Double) async {
    let deadline = Date().addingTimeInterval(timeoutSeconds)
    while Date() < deadline {
      let anyRunning =
        agent.state.isRunning || mcp.state.isRunning || collector.state.isRunning
      if !anyRunning { return }
      try? await Task.sleep(nanoseconds: 120_000_000)
    }
  }

  private func ensureCollectorInstalled() -> String {
    let fm = FileManager.default

    // 1) 已安装版本存在：优先用（稳定路径，利于 TCC 授权）
    let installed = config.collectorInstalledBinary
    let built = config.collectorBuiltBinary
    if fm.fileExists(atPath: installed.path) {
      // 开发期：如果构建产物比已安装版本更新，则自动覆盖一次，
      // 避免出现“我改了 collector 代码但 App 仍在跑旧二进制”的困惑。
      if fm.fileExists(atPath: built.path) {
        let installedMtime = (try? fm.attributesOfItem(atPath: installed.path)[.modificationDate]) as? Date
        let builtMtime = (try? fm.attributesOfItem(atPath: built.path)[.modificationDate]) as? Date
        if let installedMtime, let builtMtime, builtMtime > installedMtime {
          do {
            if fm.fileExists(atPath: installed.path) {
              try fm.removeItem(at: installed)
            }
            try fm.copyItem(at: built, to: installed)
          } catch {
            // 覆盖失败不影响运行：继续使用已安装版本
          }
        }
      }
      return installed.path
    }

    // 2) 尝试从构建产物复制一份到 dataDir/bin（稳定路径）
    do {
      try fm.createDirectory(at: installed.deletingLastPathComponent(), withIntermediateDirectories: true)
      if fm.fileExists(atPath: installed.path) {
        try fm.removeItem(at: installed)
      }
      try fm.copyItem(at: built, to: installed)
      return installed.path
    } catch {
      // 复制失败就降级：直接用构建产物路径（至少能跑起来）
      return built.path
    }
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

// MARK: - Health / shutdown helpers

private struct HealthProbeResult {
  let ok: Bool
  let service: String?
}

@MainActor
private func probeHealth(url: URL, timeoutSeconds: Double) async -> HealthProbeResult {
  var request = URLRequest(url: url)
  request.httpMethod = "GET"
  request.timeoutInterval = timeoutSeconds

  do {
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse else { return HealthProbeResult(ok: false, service: nil) }
    guard (200..<300).contains(http.statusCode) else { return HealthProbeResult(ok: false, service: nil) }

    // 尽力解析 json：如果 body 不是 json，也不影响我们判断“端口上有人”。
    if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      let service = object["service"] as? String
      return HealthProbeResult(ok: true, service: service)
    }

    return HealthProbeResult(ok: true, service: nil)
  } catch {
    return HealthProbeResult(ok: false, service: nil)
  }
}

@MainActor
private func waitForAgentGone(timeoutSeconds: Double) async -> Bool {
  let start = Date()
  let env = ProcessInfo.processInfo.environment

  let baseURL = URL(string: env["RECAPSENSE_AGENT_URL"] ?? "http://127.0.0.1:4832")
    ?? URL(string: "http://127.0.0.1:4832")!
  let healthUrl = baseURL.appendingPathComponent("health")

  while Date().timeIntervalSince(start) < timeoutSeconds {
    let probe = await probeHealth(url: healthUrl, timeoutSeconds: 0.25)
    if !probe.ok { return true }
    try? await Task.sleep(nanoseconds: 200_000_000)
  }

  return false
}

@MainActor
private func shutdownMcpSse() async throws {
  let env = ProcessInfo.processInfo.environment

  let mcpHost = env["RECAPSENSE_MCP_HOST"]?.trimmingCharacters(in: .whitespacesAndNewlines)
  let resolvedMcpHost = (mcpHost?.isEmpty == false) ? mcpHost! : "127.0.0.1"
  let mcpPort = Int(env["RECAPSENSE_MCP_PORT"] ?? "") ?? 4833
  let baseURL = URL(string: "http://\(resolvedMcpHost):\(mcpPort)") ?? URL(string: "http://127.0.0.1:4833")!

  let repoRoot = URL(fileURLWithPath: env["RECAPSENSE_REPO_ROOT"] ?? FileManager.default.currentDirectoryPath)
  let dataDir = URL(fileURLWithPath: env["RECAPSENSE_DATA_DIR"] ?? repoRoot.appendingPathComponent(".recapsense").path)
  let tokenFile = dataDir.appendingPathComponent("secret/token")
  let raw = try String(contentsOf: tokenFile, encoding: .utf8)
  let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)

  let url = baseURL.appendingPathComponent("shutdown")
  var request = URLRequest(url: url)
  request.httpMethod = "POST"
  request.timeoutInterval = 2.0
  request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

  let (_, response) = try await URLSession.shared.data(for: request)
  guard let http = response as? HTTPURLResponse else {
    throw NSError(domain: "Supervisor", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid response"])
  }
  guard (200..<300).contains(http.statusCode) || http.statusCode == 202 else {
    throw NSError(domain: "Supervisor", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: "HTTP \(http.statusCode)"])
  }
}
