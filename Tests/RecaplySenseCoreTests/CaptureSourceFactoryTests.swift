import Foundation
import Testing
@testable import RecaplySenseCore

struct CaptureSourceFactoryTests {
    @Test("CaptureSourceFactory 默认工厂应返回可用源实例")
    func shouldBuildDefaultSource() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("recaply-sense-capture-factory-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let source = try CaptureSourceFactory.makeDefault(mediaDirectory: directory)
        let typeName = String(describing: type(of: source))
        #expect(typeName.contains("CaptureSource") || typeName.contains("FallbackFrameSource"))
    }

    @Test("CaptureSourceFactory 当存在主采集时应优先主采集")
    func shouldUsePrimaryWhenProvided() throws {
        let primaryFrame = CapturedFrame(
            capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
            appName: "Primary",
            windowTitle: "P",
            contentHash: "p-hash"
        )
        let fallbackFrame = CapturedFrame(
            capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
            appName: "Fallback",
            windowTitle: "F",
            contentHash: "f-hash"
        )

        let source = try CaptureSourceFactory.makeDefault(
            mediaDirectory: FileManager.default.temporaryDirectory,
            primaryFactory: { _ in ConstantFrameSource(frame: primaryFrame) },
            fallbackFactory: { _ in ConstantFrameSource(frame: fallbackFrame) }
        )

        let frame = try source.captureFrame(at: Date(timeIntervalSince1970: 1_700_000_000))
        #expect(frame?.appName == "Primary")
    }

    @Test("CaptureSourceFactory 当主采集不存在时应使用 fallback")
    func shouldUseFallbackWhenPrimaryMissing() throws {
        let fallbackFrame = CapturedFrame(
            capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
            appName: "Fallback",
            windowTitle: "F",
            contentHash: "f-hash"
        )

        let source = try CaptureSourceFactory.makeDefault(
            mediaDirectory: FileManager.default.temporaryDirectory,
            primaryFactory: { _ in nil },
            fallbackFactory: { _ in ConstantFrameSource(frame: fallbackFrame) }
        )

        let frame = try source.captureFrame(at: Date(timeIntervalSince1970: 1_700_000_000))
        #expect(frame?.appName == "Fallback")
    }
}

private final class ConstantFrameSource: FrameSource {
    private let frame: CapturedFrame?

    init(frame: CapturedFrame?) {
        self.frame = frame
    }

    func captureFrame(at date: Date) throws -> CapturedFrame? {
        _ = date
        return frame
    }
}
