import XCTest

@testable import RecapSenseApp

final class SingleInstanceLockTests: XCTestCase {
  func testLockRejectsSecondProcess() throws {
    let dir = try makeTempDir(prefix: "recapsense-app-lock")
    let lockFile = dir.appendingPathComponent("run/recapsense-app.lock")

    // 子进程持锁，验证主进程拿不到锁（跨进程）。
    let script = """
    import Foundation
    import Darwin

    let path = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
    if path.isEmpty { exit(2) }
    let dir = (path as NSString).deletingLastPathComponent
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)

    let fd = Darwin.open(path, O_RDWR | O_CREAT, S_IRUSR | S_IWUSR | S_IRGRP | S_IROTH)
    if fd < 0 { exit(3) }

    var lock = Darwin.flock()
    lock.l_type = Int16(F_WRLCK)
    lock.l_whence = Int16(SEEK_SET)
    lock.l_start = 0
    lock.l_len = 0
    if fcntl(fd, F_SETLK, &lock) != 0 { exit(4) }

    let pidLine = "\\(getpid())\\n"
    pidLine.withCString { ptr in
      Darwin.ftruncate(fd, 0)
      Darwin.write(fd, ptr, strlen(ptr))
    }

    print("LOCKED")
    fflush(stdout)
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

    let locked = expectation(description: "child lock acquired")
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
      _ = try SingleInstanceLock(lockFile: lockFile)
      XCTFail("expected alreadyLocked")
    } catch let error as SingleInstanceLock.LockError {
      switch error {
      case .alreadyLocked(let path):
        XCTAssertEqual(path, lockFile.path)
      default:
        XCTFail("unexpected error: \(error)")
      }
    }
  }
}

