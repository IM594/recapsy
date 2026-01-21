import Foundation

struct SupervisorConfig: Equatable {
  var repoRoot: URL
  var dataDir: URL
  var agentUrl: URL

  var agentSocketEnabled: Bool

  var collectorIntervalSeconds: Double

  var logsDir: URL {
    dataDir.appendingPathComponent("logs", isDirectory: true)
  }

  var collectorBinary: URL {
    // 开发期默认：使用 SwiftPM release 产物路径。
    repoRoot
      .appendingPathComponent("apps/collector-macos/.build/release/recapsense-collector")
  }

  var baseEnvironment: [String: String] {
    // 注意：不能只传 RecapSense 自己的环境变量，否则会把 PATH 等系统变量“清空”，
    // 进而导致 `/usr/bin/env node` 找不到 node（常见报错：`env: node: No such file or directory`）。
    var env = ProcessInfo.processInfo.environment
    env["RECAPSENSE_REPO_ROOT"] = repoRoot.path
    env["RECAPSENSE_DATA_DIR"] = dataDir.path
    env["RECAPSENSE_AGENT_URL"] = agentUrl.absoluteString
    return env
  }

  static func loadFromEnvironment() -> SupervisorConfig {
    let env = ProcessInfo.processInfo.environment

    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    let repoRoot = URL(fileURLWithPath: env["RECAPSENSE_REPO_ROOT"] ?? cwd.path)

    let dataDir = URL(fileURLWithPath: env["RECAPSENSE_DATA_DIR"] ?? repoRoot.appendingPathComponent(".recapsense").path)

    let agentUrl = URL(string: env["RECAPSENSE_AGENT_URL"] ?? "http://127.0.0.1:4832")
      ?? URL(string: "http://127.0.0.1:4832")!

    let agentSocketEnabled = (env["RECAPSENSE_AGENT_SOCKET"] ?? "1") != "0"

    let interval = Double(env["RECAPSENSE_COLLECTOR_INTERVAL_SECONDS"] ?? "5") ?? 5

    return SupervisorConfig(
      repoRoot: repoRoot,
      dataDir: dataDir,
      agentUrl: agentUrl,
      agentSocketEnabled: agentSocketEnabled,
      collectorIntervalSeconds: interval
    )
  }
}
