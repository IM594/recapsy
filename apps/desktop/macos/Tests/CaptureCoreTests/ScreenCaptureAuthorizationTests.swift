import XCTest
@testable import CaptureCore

final class ScreenCaptureAuthorizationTests: XCTestCase {
    func testPassiveProbeNeverRequestsScreenRecordingAccess() {
        var preflightCalls = 0

        let granted = ScreenCaptureAuthorization.probe {
            preflightCalls += 1
            return true
        }

        XCTAssertTrue(granted)
        XCTAssertEqual(preflightCalls, 1)
    }

    func testExplicitRequestSkipsSystemPromptWhenScreenRecordingIsAlreadyGranted() {
        var preflightCalls = 0
        var requestCalls = 0

        let granted = ScreenCaptureAuthorization.requestIfNeeded(
            preflight: {
                preflightCalls += 1
                return true
            },
            request: {
                requestCalls += 1
                return false
            }
        )

        XCTAssertTrue(granted)
        XCTAssertEqual(preflightCalls, 1)
        XCTAssertEqual(requestCalls, 0)
    }

    func testExplicitRequestCallsSystemPromptOnceWhenScreenRecordingIsMissing() {
        var preflightCalls = 0
        var requestCalls = 0

        let granted = ScreenCaptureAuthorization.requestIfNeeded(
            preflight: {
                preflightCalls += 1
                return false
            },
            request: {
                requestCalls += 1
                return true
            }
        )

        XCTAssertTrue(granted)
        XCTAssertEqual(preflightCalls, 1)
        XCTAssertEqual(requestCalls, 1)
    }
}
