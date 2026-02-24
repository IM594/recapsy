import Foundation
import Testing
@testable import RecaplySenseCore

struct CaptureServiceTests {
    @Test("CaptureService captureOnce 应驱动离线管线入库")
    func shouldCaptureAndIngestViaPipeline() throws {
        let dbURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("recaply-sense-capture-service-\(UUID().uuidString).sqlite")

        let store = try MemoryStore(databaseURL: dbURL)
        try store.bootstrapSchema()

        let pipeline = OfflinePipeline(
            store: store,
            ocrProvider: VisionOCRProvider(),
            windowSize: 120
        )

        let fixedNow = Date(timeIntervalSince1970: 1_700_000_000)
        let source = StubFrameSource(
            frames: [
                CapturedFrame(
                    capturedAt: fixedNow,
                    appName: "Terminal",
                    windowTitle: "Session",
                    contentHash: "capture-hash-1",
                    rawPayload: "payload",
                    mockedText: "capture service text",
                    imagePath: nil
                )
            ]
        )

        let service = CaptureService(
            frameSource: source,
            pipeline: pipeline,
            now: { fixedNow }
        )

        let captured = try service.captureOnce()
        try service.stopAndFlush()

        #expect(captured == true)
        #expect(try store.countFrames() == 1)
        #expect(try store.countChunks() == 1)

        let results = try store.searchChunks(query: "capture", limit: 5, appFilter: nil)
        #expect(results.count == 1)
    }

    @Test("CaptureService 当无新帧时应返回 false")
    func shouldReturnFalseWhenNoFrame() throws {
        let dbURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("recaply-sense-capture-empty-\(UUID().uuidString).sqlite")

        let store = try MemoryStore(databaseURL: dbURL)
        try store.bootstrapSchema()

        let pipeline = OfflinePipeline(
            store: store,
            ocrProvider: VisionOCRProvider(),
            windowSize: 120
        )

        let source = StubFrameSource(frames: [])
        let service = CaptureService(frameSource: source, pipeline: pipeline, now: Date.init)

        #expect(try service.captureOnce() == false)
    }
}

private final class StubFrameSource: FrameSource {
    private var frames: [CapturedFrame]

    init(frames: [CapturedFrame]) {
        self.frames = frames
    }

    func captureFrame(at date: Date) throws -> CapturedFrame? {
        guard !frames.isEmpty else {
            return nil
        }

        var frame = frames.removeFirst()
        frame = CapturedFrame(
            capturedAt: date,
            appName: frame.appName,
            windowTitle: frame.windowTitle,
            contentHash: frame.contentHash,
            rawPayload: frame.rawPayload,
            mockedText: frame.mockedText,
            imagePath: frame.imagePath
        )
        return frame
    }
}
