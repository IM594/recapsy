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
    [
      "RECAPSENSE_REPO_ROOT": repoRoot.path,
      "RECAPSENSE_DATA_DIR": dataDir.path,
      "RECAPSENSE_AGENT_URL": agentUrl.absoluteString,
    ]
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

