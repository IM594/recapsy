import Foundation

enum ManagedProcessState: Equatable {
  case stopped
  case starting
  case running(pid: Int32)
  case exited(code: Int32)
  case failed(message: String)
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

  init(name: String) {
    self.name = name
  }

  func start(spec: ProcessSpec, logsDirectory: URL) {
    guard process == nil else { return }

    state = .starting
    lastErrorMessage = nil

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
          self.process = nil
          self.state = .exited(code: proc.terminationStatus)
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
    p.terminate()
    // terminationHandler 会做 teardown。
  }

  private func teardownLogHandle() {
    try? logHandle?.close()
    logHandle = nil
  }
}
