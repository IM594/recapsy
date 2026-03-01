import Foundation
import Testing
@testable import RecaplySenseCore

struct MemoryStoreObservabilityTests {
    @Test("应能读取最近采集时间、最近OCR预览和最近文本预览")
    func shouldReturnLatestCaptureAndPreviews() throws {
        let dbURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("recaply-sense-obsv-\(UUID().uuidString).sqlite")

        let store = try MemoryStore(databaseURL: dbURL)
        try store.bootstrapSchema()

        let t0 = Date(timeIntervalSince1970: 1_700_000_000)
        let t1 = t0.addingTimeInterval(60)

        _ = try store.insertFrame(
            FrameInsert(
                capturedAt: t0,
                appName: "Notes",
                windowTitle: "A",
                ocrText: "first",
                contentHash: "hash-1"
            )
        )
        _ = try store.insertFrame(
            FrameInsert(
                capturedAt: t1,
                appName: "Notes",
                windowTitle: "B",
                ocrText: "second",
                contentHash: "hash-2"
            )
        )

        _ = try store.insertChunk(
            ChunkInsert(
                startAt: t0,
                endAt: t1,
                text: "this is latest chunk text preview",
                appName: "Notes",
                windowTitle: "B"
            )
        )

        let latestCaptureAt = try store.latestFrameCapturedAt()
        let latestFramePreview = try store.latestFrameOCRPreview(maxLength: 3)
        let latestPreview = try store.latestChunkPreview(maxLength: 12)

        #expect(latestCaptureAt == t1)
        #expect(latestFramePreview == "sec")
        #expect(latestPreview == "this is late")
    }
}
