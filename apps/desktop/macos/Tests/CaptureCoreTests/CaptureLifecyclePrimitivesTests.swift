import Foundation
import XCTest
@testable import CaptureCore

final class CaptureAsyncResultGateTests: XCTestCase {
    func testTimeoutDoesNotTreatAnIncompleteAttemptAsAResult() {
        let gate = CaptureAsyncResultGate<Int>()
        let started = DispatchSemaphore(value: 0)
        let allowCompletion = DispatchSemaphore(value: 0)

        DispatchQueue.global().async {
            started.signal()
            allowCompletion.wait()
            gate.complete(42)
        }

        XCTAssertEqual(started.wait(timeout: .now() + 1), .success)
        XCTAssertNil(gate.wait(until: Date().addingTimeInterval(0.01)))

        allowCompletion.signal()
        XCTAssertEqual(gate.waitUntilFinished(), 42)
        XCTAssertEqual(gate.wait(until: Date()), 42)
    }

    func testFirstCompletionWinsWhenASecondCompletionRaces() {
        let gate = CaptureAsyncResultGate<String>()

        gate.complete("first")
        gate.complete("second")

        XCTAssertEqual(gate.waitUntilFinished(), "first")
    }
}

final class CaptureFrameHistoryTests: XCTestCase {
    func testStartingANewCaptureSessionClearsThePreviousFrame() {
        let fingerprint = CaptureFrameFingerprint(
            context: CaptureFrameContext(bundleId: "one.recapsy.fixture", windowId: 42),
            digest: "fixture-digest"
        )
        var history = CaptureFrameHistory()

        history.recordAccepted(fingerprint)
        XCTAssertEqual(history.previousAccepted, fingerprint)

        history.resetForNewSession()
        XCTAssertNil(history.previousAccepted)
    }
}
