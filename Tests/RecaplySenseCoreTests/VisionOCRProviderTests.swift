import Foundation
import Testing
@testable import RecaplySenseCore

struct VisionOCRProviderTests {
    @Test("当 frame 含 mockedText 时 VisionOCRProvider 直接返回")
    func shouldReturnMockedTextFirst() throws {
        let provider = VisionOCRProvider()
        let frame = CapturedFrame(
            capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
            appName: "Xcode",
            windowTitle: "Editor",
            contentHash: "hash-a",
            rawPayload: "",
            mockedText: "vision mocked text",
            imagePath: nil
        )

        let text = try provider.recognize(frame: frame)

        #expect(text == "vision mocked text")
    }

    @Test("当无 mockedText 且无 imagePath 时 VisionOCRProvider 应抛错")
    func shouldThrowWhenMissingImagePath() {
        let provider = VisionOCRProvider()
        let frame = CapturedFrame(
            capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
            appName: "Xcode",
            windowTitle: "Editor",
            contentHash: "hash-b",
            rawPayload: "",
            mockedText: "",
            imagePath: nil
        )

        #expect(throws: RecaplySenseError.self) {
            _ = try provider.recognize(frame: frame)
        }
    }
}
