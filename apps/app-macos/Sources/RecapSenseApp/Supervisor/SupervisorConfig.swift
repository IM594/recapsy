import Foundation

struct SupervisorConfig: Equatable {
  struct NodeInvocation: Equatable {
    var executable: String
    var argumentsPrefix: [String]
  }

  var repoRoot: URL
  var dataDir: URL
  var agentUrl: URL
  var mcpUrl: URL

  var agentSocketEnabled: Bool
  var node: NodeInvocation

  var logsDir: URL {
    dataDir.appendingPathComponent("logs", isDirectory: true)
  }

  var collectorBinary: URL {
    // 实际运行时使用的 Collector 路径（优先稳定的“已安装”路径）。
    // 说明：屏幕录制权限（TCC）对“命令行二进制”的识别比较敏感；
    // 如果我们直接跑 `.build/...`，每次重新编译都可能让系统把它当作“新程序”，导致权限失效。
    if FileManager.default.fileExists(atPath: collectorInstalledBinary.path) {
      return collectorInstalledBinary
    }
    return collectorBuiltBinary
  }

  var collectorInstalledBinary: URL {
    dataDir.appendingPathComponent("bin/recapsense-collector")
  }

  var collectorBuiltBinary: URL {
    // 开发期：优先使用 release（更接近发布行为），否则 fallback 到 debug。
    let release = repoRoot.appendingPathComponent("apps/collector-macos/.build/release/recapsense-collector")
    if FileManager.default.fileExists(atPath: release.path) {
      return release
    }
    return repoRoot.appendingPathComponent("apps/collector-macos/.build/debug/recapsense-collector")
  }

  var baseEnvironment: [String: String] {
    // 注意：不能只传 RecapSense 自己的环境变量，否则会把 PATH 等系统变量“清空”，
    // 进而导致 `/usr/bin/env node` 找不到 node（常见报错：`env: node: No such file or directory`）。
    var env = ProcessInfo.processInfo.environment

    // Finder/LaunchAgent 启动的进程，PATH 往往非常“瘦”（只有 /usr/bin:/bin...），
    // 会导致 Homebrew/nvm/asdf 等安装的 node 无法被 `/usr/bin/env` 找到。
    // 这里尽力补齐一些常见路径，让开发期更接近“开箱即用”。
    env["PATH"] = augmentPath(env["PATH"])

    env["RECAPSENSE_REPO_ROOT"] = repoRoot.path
    env["RECAPSENSE_DATA_DIR"] = dataDir.path
    env["RECAPSENSE_AGENT_URL"] = agentUrl.absoluteString
    return env
  }

  static func loadFromEnvironment() -> SupervisorConfig {
    let env = ProcessInfo.processInfo.environment

    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    var repoRoot = URL(fileURLWithPath: env["RECAPSENSE_REPO_ROOT"] ?? cwd.path)

    // 开发期常见坑：从 Finder/Spotlight 启动时，cwd 可能是 `/`，导致 repoRoot 推断错误。
    // 这里做一次“尽力而为”的 repoRoot 自动探测（从可执行文件路径向上找 package.json）。
    if env["RECAPSENSE_REPO_ROOT"] == nil, !looksLikeRepoRoot(repoRoot),
       let detected = detectRepoRootFromExecutable() {
      repoRoot = detected
    }

    let dataDir = URL(fileURLWithPath: env["RECAPSENSE_DATA_DIR"] ?? repoRoot.appendingPathComponent(".recapsense").path)

    let agentUrl = URL(string: env["RECAPSENSE_AGENT_URL"] ?? "http://127.0.0.1:4832")
      ?? URL(string: "http://127.0.0.1:4832")!

    let mcpHost = env["RECAPSENSE_MCP_HOST"]?.trimmingCharacters(in: .whitespacesAndNewlines)
    let resolvedMcpHost = (mcpHost?.isEmpty == false) ? mcpHost! : "127.0.0.1"
    let mcpPort = Int(env["RECAPSENSE_MCP_PORT"] ?? "") ?? 4833
    let mcpUrl = URL(string: "http://\(resolvedMcpHost):\(mcpPort)") ?? URL(string: "http://127.0.0.1:4833")!

    let agentSocketEnabled = (env["RECAPSENSE_AGENT_SOCKET"] ?? "1") != "0"

    // 解析 node 可执行文件：
    // - 不依赖 PATH 的隐式解析（Finder/LaunchAgent 启动时 PATH 往往不完整）
    // - 优先使用 Homebrew 的 node（通常更可控，也更可能带齐 SQLite/FTS 能力）
    // - 允许通过环境变量强制指定
    var envForSearch = env
    envForSearch["PATH"] = augmentPath(envForSearch["PATH"])
    let node = resolveNodeInvocation(env: envForSearch)

    return SupervisorConfig(
      repoRoot: repoRoot,
      dataDir: dataDir,
      agentUrl: agentUrl,
      mcpUrl: mcpUrl,
      agentSocketEnabled: agentSocketEnabled,
      node: node
    )
  }
}

private func looksLikeRepoRoot(_ dir: URL) -> Bool {
  let fm = FileManager.default
  let packageJson = dir.appendingPathComponent("package.json").path
  let agentServer = dir.appendingPathComponent("apps/agent/src/server.mjs").path
  return fm.fileExists(atPath: packageJson) && fm.fileExists(atPath: agentServer)
}

private func detectRepoRootFromExecutable(maxDepth: Int = 8) -> URL? {
  guard let raw = CommandLine.arguments.first else { return nil }
  let exe = URL(fileURLWithPath: raw).resolvingSymlinksInPath().standardizedFileURL
  var dir = exe.deletingLastPathComponent()

  for _ in 0..<maxDepth {
    if looksLikeRepoRoot(dir) { return dir }
    let parent = dir.deletingLastPathComponent()
    if parent.path == dir.path { break }
    dir = parent
  }
  return nil
}

private func augmentPath(_ original: String?) -> String {
  var paths = (original ?? "")
    .split(separator: ":")
    .map(String.init)
    .filter { !$0.isEmpty }

  let home = FileManager.default.homeDirectoryForCurrentUser.path
  let candidates: [String] = [
    "/opt/homebrew/bin", // Apple Silicon Homebrew
    "/usr/local/bin", // Intel Homebrew（也可能是用户自定义安装）
    "\(home)/.volta/bin",
    "\(home)/.asdf/shims",
    "\(home)/.local/share/mise/shims",
  ] + nvmNodeBinCandidates(home: home)

  for candidate in candidates {
    if paths.contains(candidate) { continue }
    if FileManager.default.fileExists(atPath: candidate) {
      paths.append(candidate)
    }
  }

  // 去重保持稳定顺序（原 PATH 优先，其次补齐路径）。
  var deduped: [String] = []
  var seen: Set<String> = []
  for p in paths where !p.isEmpty {
    if seen.contains(p) { continue }
    seen.insert(p)
    deduped.append(p)
  }

  return deduped.joined(separator: ":")
}

private func resolveNodeInvocation(env: [String: String]) -> SupervisorConfig.NodeInvocation {
  let fm = FileManager.default

  if let override = env["RECAPSENSE_NODE_BIN"]?.trimmingCharacters(in: .whitespacesAndNewlines),
     !override.isEmpty,
     fm.fileExists(atPath: override)
  {
    return SupervisorConfig.NodeInvocation(executable: override, argumentsPrefix: [])
  }

  // 1) 常见稳定路径优先（比 PATH 更确定）
  let preferred = [
    "/opt/homebrew/bin/node", // Apple Silicon Homebrew
    "/usr/local/bin/node", // Intel Homebrew
  ]
  for candidate in preferred where fm.fileExists(atPath: candidate) {
    return SupervisorConfig.NodeInvocation(executable: candidate, argumentsPrefix: [])
  }

  // 2) 在 PATH 中查找 node（兜底）
  if let path = env["PATH"] {
    for dir in path.split(separator: ":").map(String.init) where !dir.isEmpty {
      let candidate = URL(fileURLWithPath: dir).appendingPathComponent("node").path
      if fm.fileExists(atPath: candidate) {
        return SupervisorConfig.NodeInvocation(executable: candidate, argumentsPrefix: [])
      }
    }
  }

  // 3) 最后兜底：交给 /usr/bin/env 去解析（可能失败，但错误更直观）
  return SupervisorConfig.NodeInvocation(executable: "/usr/bin/env", argumentsPrefix: ["node"])
}

private func nvmNodeBinCandidates(home: String) -> [String] {
  let base = URL(fileURLWithPath: home)
    .appendingPathComponent(".nvm/versions/node", isDirectory: true)

  guard let children = try? FileManager.default.contentsOfDirectory(
    at: base,
    includingPropertiesForKeys: [.isDirectoryKey],
    options: [.skipsHiddenFiles]
  ) else {
    return []
  }

  var best: (version: [Int], url: URL)? = nil

  for dir in children {
    guard (try? dir.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else { continue }
    let name = dir.lastPathComponent
    guard name.hasPrefix("v") else { continue }
    let parsed = parseSemver(String(name.dropFirst()))
    guard !parsed.isEmpty else { continue }

    if let current = best {
      if compareSemver(parsed, current.version) == .orderedDescending {
        best = (parsed, dir)
      }
    } else {
      best = (parsed, dir)
    }
  }

  guard let best else { return [] }
  return [best.url.appendingPathComponent("bin", isDirectory: true).path]
}

private func parseSemver(_ raw: String) -> [Int] {
  let parts = raw.split(separator: ".").prefix(3)
  var numbers: [Int] = []
  for part in parts {
    if let n = Int(part) {
      numbers.append(n)
    } else {
      return []
    }
  }
  return numbers
}

private func compareSemver(_ a: [Int], _ b: [Int]) -> ComparisonResult {
  let maxLen = max(a.count, b.count)
  for i in 0..<maxLen {
    let lhs = i < a.count ? a[i] : 0
    let rhs = i < b.count ? b[i] : 0
    if lhs < rhs { return .orderedAscending }
    if lhs > rhs { return .orderedDescending }
  }
  return .orderedSame
}
