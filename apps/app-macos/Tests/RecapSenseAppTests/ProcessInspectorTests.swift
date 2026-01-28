import XCTest

@testable import RecapSenseApp

final class ProcessInspectorTests: XCTestCase {
  func testIsPidAlive() throws {
    XCTAssertFalse(ProcessInspector.isPidAlive(0))
    XCTAssertFalse(ProcessInspector.isPidAlive(1))
    XCTAssertTrue(ProcessInspector.isPidAlive(getpid()))
  }

  func testReadPidFromLockFile() throws {
    let dir = try makeTempDir(prefix: "recapsense-app-lockfile")
    let file = dir.appendingPathComponent("pid.lock")
    try "123\n".data(using: .utf8)!.write(to: file)
    XCTAssertEqual(ProcessInspector.readPidFromLockFile(file), 123)

    let bad = dir.appendingPathComponent("bad.lock")
    try "0\n".data(using: .utf8)!.write(to: bad)
    XCTAssertNil(ProcessInspector.readPidFromLockFile(bad))
  }
}

