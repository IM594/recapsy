import Foundation
import Darwin

/// Collector 单实例锁（按 dataDir）。
///
/// 说明：
/// - 目标是避免多个 recapsense-collector 同时写入同一个 Agent/数据目录，导致黑名单失效、日志乱序等问题。
/// - 使用非阻塞独占锁（fcntl(F_SETLK)），失败则直接报错退出。
final class CollectorInstanceLock {
  enum LockError: Error, CustomStringConvertible {
    case alreadyLocked(path: String, pidHint: Int32?)
    case openFailed(path: String, message: String)
    case lockFailed(path: String, message: String)

    var description: String {
      switch self {
      case .alreadyLocked(let path, let pidHint):
        if let pidHint {
          return "检测到已有另一个 collector 正在运行（pid=\(pidHint)，锁文件：\(path)）。请先停止旧实例。"
        }
        return "检测到已有另一个 collector 正在运行（锁文件：\(path)）。请先停止旧实例。"
      case .openFailed(let path, let message):
        return "无法创建/打开锁文件：\(path)（\(message)）"
      case .lockFailed(let path, let message):
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

    var lock = Darwin.flock()
    lock.l_type = Int16(F_WRLCK)
    lock.l_whence = Int16(SEEK_SET)
    lock.l_start = 0
    lock.l_len = 0

    if fcntl(fd, F_SETLK, &lock) != 0 {
      let message = lastErrnoMessage()
      if errno == EACCES || errno == EAGAIN {
        throw LockError.alreadyLocked(path: path, pidHint: readPidHint(path: path))
      }
      throw LockError.lockFailed(path: path, message: message)
    }

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

private func readPidHint(path: String) -> Int32? {
  guard let raw = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
  let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  guard let pid = Int32(trimmed) else { return nil }
  return pid > 0 ? pid : nil
}

