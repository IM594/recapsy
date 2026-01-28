import XCTest

@testable import RecapSenseApp

final class ManagedProcessStateTests: XCTestCase {
  func testIsRunning() throws {
    XCTAssertFalse(ManagedProcessState.stopped.isRunning)
    XCTAssertFalse(ManagedProcessState.starting.isRunning)
    XCTAssertTrue(ManagedProcessState.running(pid: 123).isRunning)
    XCTAssertTrue(ManagedProcessState.runningExternal.isRunning)
    XCTAssertFalse(ManagedProcessState.exited(code: 0).isRunning)
    XCTAssertFalse(ManagedProcessState.failed(message: "x").isRunning)
  }
}

