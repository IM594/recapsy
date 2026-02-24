import Foundation
import Testing
@testable import RecaplySenseCore

struct FallbackFrameSourceTests {
    @Test("当主采集成功时不应触发fallback")
    func shouldUsePrimarySourceFirst() throws {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let primaryFrame = CapturedFrame(
            capturedAt: now,
            appName: "PrimaryApp",
            windowTitle: "PrimaryWindow",
            contentHash: "primary-hash"
        )

        let primary = StubFrameSource(result: .success(primaryFrame))
        let fallback = StubFrameSource(result: .success(nil))

        let source = FallbackFrameSource(primary: primary, fallback: fallback)
        let frame = try source.captureFrame(at: now)

        #expect(frame?.appName == "PrimaryApp")
        #expect(primary.captureCallCount == 1)
        #expect(fallback.captureCallCount == 0)
    }

    @Test("当主采集抛错时应自动回退")
    func shouldFallbackWhenPrimaryThrows() throws {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let fallbackFrame = CapturedFrame(
            capturedAt: now,
            appName: "FallbackApp",
            windowTitle: "FallbackWindow",
            contentHash: "fallback-hash"
        )

        let primary = StubFrameSource(result: .failure(RecaplySenseError.capture(message: "primary failed")))
        let fallback = StubFrameSource(result: .success(fallbackFrame))

        let source = FallbackFrameSource(primary: primary, fallback: fallback)
        let frame = try source.captureFrame(at: now)

        #expect(frame?.appName == "FallbackApp")
        #expect(primary.captureCallCount == 1)
        #expect(fallback.captureCallCount == 1)
    }

    @Test("当主采集返回nil时应自动回退")
    func shouldFallbackWhenPrimaryReturnsNil() throws {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let fallbackFrame = CapturedFrame(
            capturedAt: now,
            appName: "FallbackApp",
            windowTitle: "FallbackWindow",
            contentHash: "fallback-hash"
        )

        let primary = StubFrameSource(result: .success(nil))
        let fallback = StubFrameSource(result: .success(fallbackFrame))

        let source = FallbackFrameSource(primary: primary, fallback: fallback)
        let frame = try source.captureFrame(at: now)

        #expect(frame?.appName == "FallbackApp")
        #expect(primary.captureCallCount == 1)
        #expect(fallback.captureCallCount == 1)
    }
}

private final class StubFrameSource: FrameSource {
    private let result: Result<CapturedFrame?, Error>
    private(set) var captureCallCount = 0

    init(result: Result<CapturedFrame?, Error>) {
        self.result = result
    }

    func captureFrame(at date: Date) throws -> CapturedFrame? {
        _ = date
        captureCallCount += 1
        return try result.get()
    }
}
