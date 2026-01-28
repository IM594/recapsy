import XCTest

@testable import RecapSenseCollector

final class CollectorInstanceLockTests: XCTestCase {
  func testLockPreventsSecondInstanceUntilReleased() throws {
    let dir = try makeTempDir(prefix: "recapsense-collector-lock")
    let lockFile = dir.appendingPathComponent("run/collector.lock")

    // fcntl 锁是“按进程”管理的：同一进程内重复加锁可能会成功。
    // 因此这里用子进程持锁，来验证跨进程的单实例行为。
    let script = """
    import Foundation
    import Darwin

    func lastErrnoMessage() -> String { String(cString: strerror(errno)) }

    let lockPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
    if lockPath.isEmpty {
      fputs("missing lock path\\n", stderr)
      exit(2)
    }

    let dir = (lockPath as NSString).deletingLastPathComponent
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)

    let fd = Darwin.open(lockPath, O_RDWR | O_CREAT, S_IRUSR | S_IWUSR | S_IRGRP | S_IROTH)
    if fd < 0 {
      fputs("open failed: \\(lastErrnoMessage())\\n", stderr)
      exit(3)
    }

    var lock = Darwin.flock()
    lock.l_type = Int16(F_WRLCK)
    lock.l_whence = Int16(SEEK_SET)
    lock.l_start = 0
    lock.l_len = 0

    if fcntl(fd, F_SETLK, &lock) != 0 {
      fputs("lock failed: \\(lastErrnoMessage())\\n", stderr)
      exit(4)
    }

    let pidLine = "\\(getpid())\\n"
    pidLine.withCString { ptr in
      Darwin.ftruncate(fd, 0)
      Darwin.write(fd, ptr, strlen(ptr))
    }

    print("LOCKED")
    fflush(stdout)
    // hold until killed
    while true { sleep(1) }
    """

    let scriptURL = dir.appendingPathComponent("lock-holder.swift")
    try script.data(using: .utf8)!.write(to: scriptURL)

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
    process.arguments = ["swift", scriptURL.path, lockFile.path]

    let out = Pipe()
    process.standardOutput = out
    process.standardError = Pipe()

    try process.run()
    defer {
      if process.isRunning {
        process.terminate()
        process.waitUntilExit()
      }
    }

    // wait for "LOCKED" without blocking forever
    let locked = expectation(description: "lock acquired by child process")
    var buffer = Data()
    out.fileHandleForReading.readabilityHandler = { handle in
      let chunk = handle.availableData
      if chunk.isEmpty { return }
      buffer.append(chunk)
      if String(data: buffer, encoding: .utf8)?.contains("LOCKED") == true {
        handle.readabilityHandler = nil
        locked.fulfill()
      }
    }

    wait(for: [locked], timeout: 5)

    do {
      _ = try CollectorInstanceLock(lockFile: lockFile)
      XCTFail("expected alreadyLocked")
    } catch let error as CollectorInstanceLock.LockError {
      switch error {
      case .alreadyLocked(let path, let pidHint):
        XCTAssertEqual(path, lockFile.path)
        XCTAssertNotNil(pidHint)
      default:
        XCTFail("unexpected error: \(error)")
      }
    }
  }
}
