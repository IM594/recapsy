import Foundation
import Darwin

enum ProcessInspector {
  static func isPidAlive(_ pid: Int32) -> Bool {
    guard pid > 1 else { return false }
    let rc = kill(pid, 0)
    if rc == 0 { return true }
    if errno == ESRCH { return false }
    return true
  }

  static func readPidFromLockFile(_ url: URL) -> Int32? {
    guard let raw = try? String(contentsOf: url, encoding: .utf8) else { return nil }
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let pid = Int32(trimmed), pid > 1 else { return nil }
    return pid
  }

  static func collectorProcesses(repoRoot: URL, dataDir: URL) -> [CollectorProcessInfo] {
    let repoPath = repoRoot.standardizedFileURL.path
    let dataPath = dataDir.standardizedFileURL.path

    var results: [CollectorProcessInfo] = []
    for pid in listAllPids() {
      guard let exe = pidPath(pid) else { continue }
      if URL(fileURLWithPath: exe).lastPathComponent != "recapsense-collector" { continue }

      // 只关注“当前 repoRoot/dataDir”相关的进程，避免误伤系统里其他同名二进制。
      if !(exe.hasPrefix(repoPath) || exe.hasPrefix(dataPath)) { continue }
      results.append(CollectorProcessInfo(pid: pid, path: exe))
    }

    results.sort { $0.pid < $1.pid }
    return results
  }

  static func terminate(pid: Int32, timeoutSeconds: Double = 1.2) async -> Bool {
    guard pid > 1 else { return false }
    if !isPidAlive(pid) { return true }

    if kill(pid, SIGTERM) != 0, errno == ESRCH { return true }

    let deadline = Date().addingTimeInterval(max(0.2, timeoutSeconds))
    while Date() < deadline {
      if !isPidAlive(pid) { return true }
      try? await Task.sleep(nanoseconds: 120_000_000)
    }

    _ = kill(pid, SIGKILL)
    let hardDeadline = Date().addingTimeInterval(1.0)
    while Date() < hardDeadline {
      if !isPidAlive(pid) { return true }
      try? await Task.sleep(nanoseconds: 120_000_000)
    }

    return !isPidAlive(pid)
  }
}

private func listAllPids() -> [Int32] {
  let size = proc_listpids(UInt32(PROC_ALL_PIDS), 0, nil, 0)
  if size <= 0 { return [] }

  let count = Int(size) / MemoryLayout<pid_t>.size
  var buffer = [pid_t](repeating: 0, count: count)

  let bytes = buffer.withUnsafeMutableBufferPointer { ptr -> Int32 in
    guard let base = ptr.baseAddress else { return 0 }
    return proc_listpids(UInt32(PROC_ALL_PIDS), 0, base, Int32(size))
  }

  let actual = max(0, Int(bytes) / MemoryLayout<pid_t>.size)
  let safeEnd = min(actual, buffer.count)
  if safeEnd <= 0 { return [] }

  var pids: [Int32] = []
  pids.reserveCapacity(safeEnd)
  for i in 0..<safeEnd {
    let pid = Int32(buffer[i])
    if pid > 0 { pids.append(pid) }
  }
  return pids
}

private func pidPath(_ pid: Int32) -> String? {
  // 在部分 SDK/Swift 头文件导入环境下，`PROC_PIDPATHINFO_MAXSIZE` 宏可能不可见；
  // 这里使用一个足够保守的固定缓冲区（4*MAXPATHLEN 通常为 4096）。
  var buffer = [CChar](repeating: 0, count: 4096)
  let bufferSize = UInt32(buffer.count)
  let rc = buffer.withUnsafeMutableBufferPointer { ptr -> Int32 in
    guard let base = ptr.baseAddress else { return 0 }
    return proc_pidpath(pid, base, bufferSize)
  }
  if rc <= 0 { return nil }
  return String(cString: buffer)
}
