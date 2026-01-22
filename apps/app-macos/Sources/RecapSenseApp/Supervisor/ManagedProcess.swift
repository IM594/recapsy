import Foundation
import Darwin

enum ManagedProcessState: Equatable {
  case stopped
  case starting
  case running(pid: Int32)
  /// 端口/health 检测到“已有外部进程在跑”，当前 App 不重复拉起。
  case runningExternal
  case exited(code: Int32)
  case failed(message: String)
}

extension ManagedProcessState {
  var isRunning: Bool {
    switch self {
    case .running, .runningExternal:
      return true
    default:
      return false
    }
  }
}

struct ProcessSpec: Equatable {
  let label: String
  let executable: String
  let arguments: [String]
  let workingDirectory: String
  let environment: [String: String]
  var requiresExecutableOnDisk: Bool = false
}

@MainActor
final class ManagedProcess: ObservableObject {
  let name: String
  @Published private(set) var state: ManagedProcessState = .stopped
  @Published private(set) var lastErrorMessage: String? = nil
  @Published private(set) var logFile: URL? = nil

  private var process: Process? = nil
  private var logHandle: FileHandle? = nil
  private var lastSpec: ProcessSpec? = nil
  private var stopRequested = false

  init(name: String) {
    self.name = name
  }

  func markExternalRunning(logFile: URL) {
    guard process == nil else { return }
    self.logFile = logFile
    lastErrorMessage = nil
    state = .runningExternal
  }

  func markStoppedIfExternal() {
    if case .runningExternal = state {
      state = .stopped
    }
  }

  func markFailed(message: String) {
    lastErrorMessage = message
    state = .failed(message: message)
  }

  func start(spec: ProcessSpec, logsDirectory: URL) {
    guard process == nil else { return }

    state = .starting
    lastErrorMessage = nil
    lastSpec = spec
    stopRequested = false

    if spec.requiresExecutableOnDisk && !FileManager.default.fileExists(atPath: spec.executable) {
      let message = "可执行文件不存在：\(spec.executable)"
      lastErrorMessage = message
      state = .failed(message: message)
      return
    }

    do {
      try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
      let logFile = logsDirectory.appendingPathComponent("\(spec.label).log")
      self.logFile = logFile

      if !FileManager.default.fileExists(atPath: logFile.path) {
        FileManager.default.createFile(atPath: logFile.path, contents: nil)
      }

      let handle = try FileHandle(forWritingTo: logFile)
      try handle.seekToEnd()
      logHandle = handle
      appendStartSeparator(handle: handle, spec: spec)

      let p = Process()
      p.currentDirectoryURL = URL(fileURLWithPath: spec.workingDirectory)
      p.executableURL = URL(fileURLWithPath: spec.executable)
      p.arguments = spec.arguments
      p.environment = spec.environment

      // 最简单、最稳的日志方案：让子进程直接把 stdout/stderr 重定向到同一个文件。
      // 这样我们不需要额外的 pipe/readabilityHandler，也避免 Swift 并发隔离问题。
      p.standardOutput = handle
      p.standardError = handle

      p.terminationHandler = { [weak self] proc in
        Task { @MainActor in
          guard let self else { return }
          let code = proc.terminationStatus
          let reason = proc.terminationReason

          // 用户主动 stop：视为“已停止”，不标红。
          if self.stopRequested {
            self.state = .stopped
          } else if reason == .exit, code == 0 {
            self.state = .stopped
          } else if code == 127, self.isLikelyMissingNode() {
            let message = "找不到 node（PATH 中不存在）。开发期请确保终端里 `node -v` 可用，并从该终端启动 `npm run dev:app:macos`。"
            self.lastErrorMessage = message
            self.state = .failed(message: message)
          } else {
            self.state = .exited(code: code)
          }

          self.stopRequested = false
          self.process = nil
          self.teardownLogHandle()
        }
      }

      try p.run()
      process = p
      state = .running(pid: p.processIdentifier)
    } catch {
      lastErrorMessage = String(describing: error)
      state = .failed(message: String(describing: error))
      process = nil
      teardownLogHandle()
    }
  }

  func stop() {
    guard let p = process else { return }
    // 先温和结束，避免损坏数据；必要时未来可以加强制 kill。
    stopRequested = true
    p.terminate()

    // 兜底：有些情况下子进程可能卡住（例如端口占用导致异常、或 Node 事件循环被某些句柄挂住），
    // 为了避免“退出 App 后端口仍被占用”，我们做一个超时强杀。
    let pid = p.processIdentifier
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 1_500_000_000)
      guard let current = self.process else { return }
      guard current.processIdentifier == pid else { return }
      guard current.isRunning else { return }
      kill(pid, SIGKILL)
    }
    // terminationHandler 会做 teardown。
  }

  private func isLikelyMissingNode() -> Bool {
    // 我们用 `/usr/bin/env node ...` 来启动 Node 进程；
    // 当 PATH 缺失或 node 未安装时，常见退出码是 127。
    guard let spec = lastSpec else { return false }
    guard spec.executable == "/usr/bin/env" else { return false }
    guard spec.arguments.first == "node" else { return false }
    return true
  }

  private func teardownLogHandle() {
    try? logHandle?.close()
    logHandle = nil
  }

  private func appendStartSeparator(handle: FileHandle, spec: ProcessSpec) {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "zh_CN")
    formatter.timeZone = TimeZone.current
    formatter.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
    let ts = formatter.string(from: Date())

    let line = String(repeating: "=", count: 88)
    let payload =
      """

\(line)
[RecapSense] \(spec.label) 启动：\(ts)
executable：\(spec.executable)
args：\(spec.arguments.joined(separator: " "))
cwd：\(spec.workingDirectory)
\(line)

"""

    if let data = payload.data(using: .utf8) {
      handle.write(data)
    }
  }
}
