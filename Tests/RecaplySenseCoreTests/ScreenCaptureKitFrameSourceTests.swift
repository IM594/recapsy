#if os(macOS) && canImport(ScreenCaptureKit)
import AppKit
import Foundation
import ScreenCaptureKit
import Testing
@testable import RecaplySenseCore

struct ScreenCaptureKitFrameSourceTests {
    @Test("ScreenCaptureKitFrameSource 当前台应用缺失时应返回 nil")
    func shouldReturnNilWhenFrontmostAppMissing() throws {
        let writer = StubFrameArtifactWriter()
        let source = ScreenCaptureKitFrameSource(
            artifactWriter: writer,
            appNameProvider: { nil },
            imageProvider: {
                throw RecaplySenseError.capture(message: "should not capture")
            }
        )

        let frame = try source.captureFrame(at: Date(timeIntervalSince1970: 1_700_000_000))
        #expect(frame == nil)
        #expect(writer.writeCallCount == 0)
    }

    @Test("ScreenCaptureKitFrameSource 应写入并返回帧元数据")
    func shouldBuildFrameWithArtifact() throws {
        let image = try #require(makeImage(color: .systemRed))
        let writer = StubFrameArtifactWriter(result: FrameArtifact(path: "/tmp/sckit.png", hash: "sckit-hash"))

        let source = ScreenCaptureKitFrameSource(
            artifactWriter: writer,
            appNameProvider: { "Safari" },
            imageProvider: { image }
        )

        let frame = try source.captureFrame(at: Date(timeIntervalSince1970: 1_700_000_000))
        let value = try #require(frame)

        #expect(value.appName == "Safari")
        #expect(value.windowTitle == "Safari")
        #expect(value.imagePath == "/tmp/sckit.png")
        #expect(value.contentHash == "sckit-hash")
        #expect(writer.writeCallCount == 1)
    }

    @Test("ScreenCaptureKitFrameSource 当截图失败时应透传错误")
    func shouldThrowWhenImageProviderFails() throws {
        struct CaptureFailure: Error {}

        let writer = StubFrameArtifactWriter()
        let source = ScreenCaptureKitFrameSource(
            artifactWriter: writer,
            appNameProvider: { "Safari" },
            imageProvider: {
                throw CaptureFailure()
            }
        )

        #expect(throws: CaptureFailure.self) {
            _ = try source.captureFrame(at: Date(timeIntervalSince1970: 1_700_000_000))
        }
        #expect(writer.writeCallCount == 0)
    }
}

private final class StubFrameArtifactWriter: FrameArtifactWriting {
    private let result: FrameArtifact
    private(set) var writeCallCount = 0

    init(result: FrameArtifact = FrameArtifact(path: "/tmp/default.png", hash: "default-hash")) {
        self.result = result
    }

    func write(cgImage: CGImage, filename: String) throws -> FrameArtifact {
        _ = cgImage
        _ = filename
        writeCallCount += 1
        return result
    }
}

private func makeImage(color: NSColor) -> CGImage? {
    guard let context = CGContext(
        data: nil,
        width: 1,
        height: 1,
        bitsPerComponent: 8,
        bytesPerRow: 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        return nil
    }

    context.setFillColor(color.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: 1, height: 1))
    return context.makeImage()
}
#endif
