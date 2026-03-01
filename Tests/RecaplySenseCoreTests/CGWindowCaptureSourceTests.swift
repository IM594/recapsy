#if os(macOS)
import AppKit
import Foundation
import Testing
@testable import RecaplySenseCore

struct CGWindowCaptureSourceTests {
    @Test("CGWindowCaptureSource 当前台应用缺失时应返回 nil")
    func shouldReturnNilWhenFrontmostAppMissing() throws {
        let env = StubCGWindowCaptureEnvironment(
            frontmostApplicationName: nil,
            windows: [],
            imageByWindowID: [:]
        )
        let writer = StubFrameArtifactWriter()
        let source = CGWindowCaptureSource(environment: env, artifactWriter: writer)

        let frame = try source.captureFrame(at: Date(timeIntervalSince1970: 1_700_000_000))
        #expect(frame == nil)
        #expect(writer.writeCallCount == 0)
    }

    @Test("CGWindowCaptureSource 应返回包含应用与窗口信息的帧")
    func shouldBuildFrameFromWindowAndImage() throws {
        let image = try #require(makeImage(color: .systemBlue))
        let windows: [[String: Any]] = [
            [
                kCGWindowLayer as String: NSNumber(value: 0),
                kCGWindowOwnerName as String: "Xcode",
                kCGWindowNumber as String: NSNumber(value: 99),
                kCGWindowName as String: "Editor"
            ]
        ]
        let env = StubCGWindowCaptureEnvironment(
            frontmostApplicationName: "Xcode",
            windows: windows,
            imageByWindowID: [CGWindowID(99): image]
        )
        let writer = StubFrameArtifactWriter(result: FrameArtifact(path: "/tmp/fake.png", hash: "hash-123"))
        let source = CGWindowCaptureSource(environment: env, artifactWriter: writer)

        let frame = try source.captureFrame(at: Date(timeIntervalSince1970: 1_700_000_000))
        let value = try #require(frame)

        #expect(value.appName == "Xcode")
        #expect(value.windowTitle == "Editor")
        #expect(value.contentHash == "hash-123")
        #expect(value.imagePath == "/tmp/fake.png")
        #expect(writer.writeCallCount == 1)
    }

    @Test("CGWindowCaptureSource 当窗口截图缺失时应返回 nil")
    func shouldReturnNilWhenWindowImageMissing() throws {
        let windows: [[String: Any]] = [
            [
                kCGWindowLayer as String: NSNumber(value: 0),
                kCGWindowOwnerName as String: "Xcode",
                kCGWindowNumber as String: NSNumber(value: 99),
                kCGWindowName as String: "Editor"
            ]
        ]
        let env = StubCGWindowCaptureEnvironment(
            frontmostApplicationName: "Xcode",
            windows: windows,
            imageByWindowID: [:]
        )
        let writer = StubFrameArtifactWriter()
        let source = CGWindowCaptureSource(environment: env, artifactWriter: writer)

        let frame = try source.captureFrame(at: Date(timeIntervalSince1970: 1_700_000_000))
        #expect(frame == nil)
        #expect(writer.writeCallCount == 0)
    }
}

private final class StubCGWindowCaptureEnvironment: CGWindowCaptureEnvironment {
    private let frontmostApplicationNameValue: String?
    private let windowsValue: [[String: Any]]
    private let imageByWindowID: [CGWindowID: CGImage]

    init(frontmostApplicationName: String?, windows: [[String: Any]], imageByWindowID: [CGWindowID: CGImage]) {
        self.frontmostApplicationNameValue = frontmostApplicationName
        self.windowsValue = windows
        self.imageByWindowID = imageByWindowID
    }

    func frontmostApplicationName() -> String? {
        frontmostApplicationNameValue
    }

    func windowList() -> [[String: Any]]? {
        windowsValue
    }

    func captureWindowImage(windowID: CGWindowID) -> CGImage? {
        imageByWindowID[windowID]
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
