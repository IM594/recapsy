import Foundation
import Darwin

/// 单实例锁（开发期用来避免“同时跑多个 recapsense-app”，从而导致端口占用/状态错乱）。
///
/// 说明：
/// - SwiftPM 可执行程序形态下，macOS 不会像 .app 那样自动做单实例复用；
/// - 用户很容易不小心启动两次，然后第二个实例启动 MCP/Agent 就会遇到 `EADDRINUSE`。
final class SingleInstanceLock {
  enum LockError: Error, CustomStringConvertible {
    case alreadyLocked(path: String)
    case openFailed(path: String, message: String)
    case flockFailed(path: String, message: String)

    var description: String {
      switch self {
      case .alreadyLocked(let path):
        return "已有另一个 RecapSense 实例在运行（锁文件：\(path)）。请先退出旧实例。"
      case .openFailed(let path, let message):
        return "无法创建/打开锁文件：\(path)（\(message)）"
      case .flockFailed(let path, let message):
        return "无法锁定文件：\(path)（\(message)）"
      }
    }
  }

  private let lockFile: URL
  private var fd: Int32 = -1

  init(lockFile: URL) throws {
    self.lockFile = lockFile

    try FileManager.default.createDirectory(
      at: lockFile.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )

    let path = lockFile.path
    let handle = Darwin.open(path, O_RDWR | O_CREAT, S_IRUSR | S_IWUSR | S_IRGRP | S_IROTH)
    if handle < 0 {
      throw LockError.openFailed(path: path, message: lastErrnoMessage())
    }

    fd = handle

    // 非阻塞独占锁：使用 fcntl(F_SETLK)。
    // - 如果已被其他进程持有锁，常见 errno 是 EACCES/EAGAIN
    // - 选择 fcntl 的原因：Swift 的 Darwin 模块里 `flock` 名称容易与 `struct flock` 冲突
    var lock = Darwin.flock()
    lock.l_type = Int16(F_WRLCK)
    lock.l_whence = Int16(SEEK_SET)
    lock.l_start = 0
    lock.l_len = 0 // 0 表示锁整个文件

    if fcntl(fd, F_SETLK, &lock) != 0 {
      let message = lastErrnoMessage()
      if errno == EACCES || errno == EAGAIN {
        throw LockError.alreadyLocked(path: path)
      }
      throw LockError.flockFailed(path: path, message: message)
    }

    // 写入 pid 便于排查（不影响锁本身语义）。
    let pidLine = "\(getpid())\n"
    pidLine.withCString { ptr in
      Darwin.ftruncate(fd, 0)
      Darwin.write(fd, ptr, strlen(ptr))
    }
  }

  deinit {
    guard fd >= 0 else { return }

    var lock = Darwin.flock()
    lock.l_type = Int16(F_UNLCK)
    lock.l_whence = Int16(SEEK_SET)
    lock.l_start = 0
    lock.l_len = 0
    _ = fcntl(fd, F_SETLK, &lock)

    Darwin.close(fd)
    fd = -1
  }
}

private func lastErrnoMessage() -> String {
  String(cString: strerror(errno))
}
