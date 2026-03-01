import Foundation
import Testing
@testable import RecaplySenseCore

struct AppRuntimeBuilderTests {
    @Test("AppRuntimeBuilder 应构建可用运行时")
    func shouldBuildRuntimeSuccessfully() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("recaply-sense-runtime-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

        let databaseURL = root.appendingPathComponent("memory.sqlite")
        let mediaDirectory = root.appendingPathComponent("media", isDirectory: true)

        let runtime = try AppRuntimeBuilder.build(
            databaseURL: databaseURL,
            mediaDirectory: mediaDirectory,
            captureInterval: 2.0,
            windowSize: 120,
            frameSourceFactory: { _ in StubFrameSource(frame: nil) }
        )

        #expect(runtime.lifecycleController.state == .stopped)
        #expect(try runtime.store.countFrames() == 0)
        #expect(try runtime.store.countChunks() == 0)
        #expect(FileManager.default.fileExists(atPath: databaseURL.path))
    }

    @Test("AppRuntimeBuilder 当采集源构建失败时应抛错")
    func shouldThrowWhenFrameSourceFactoryFails() throws {
        struct BuildError: Error {}

        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("recaply-sense-runtime-fail-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

        let databaseURL = root.appendingPathComponent("memory.sqlite")
        let mediaDirectory = root.appendingPathComponent("media", isDirectory: true)

        #expect(throws: BuildError.self) {
            _ = try AppRuntimeBuilder.build(
                databaseURL: databaseURL,
                mediaDirectory: mediaDirectory,
                frameSourceFactory: { _ in throw BuildError() }
            )
        }
    }
}

private final class StubFrameSource: FrameSource {
    private let frame: CapturedFrame?

    init(frame: CapturedFrame?) {
        self.frame = frame
    }

    func captureFrame(at date: Date) throws -> CapturedFrame? {
        _ = date
        return frame
    }
}
