import Foundation
import Testing
@testable import RecaplySenseCore

struct OfflinePipelineTests {
    @Test("采集到的文本应压实到chunk并可被本地检索")
    func shouldIngestCompactAndSearch() throws {
        let dbURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("recaply-sense-pipeline-\(UUID().uuidString).sqlite")

        let store = try MemoryStore(databaseURL: dbURL)
        try store.bootstrapSchema()

        let pipeline = OfflinePipeline(
            store: store,
            ocrProvider: StubOCRProvider(),
            windowSize: 120
        )

        let t0 = Date(timeIntervalSince1970: 1_700_000_000)
        try pipeline.ingest(
            frame: CapturedFrame(
                capturedAt: t0,
                appName: "Xcode",
                windowTitle: "Editor",
                contentHash: "hash-1",
                rawPayload: "payload-1",
                mockedText: "offline search baseline"
            )
        )

        try pipeline.ingest(
            frame: CapturedFrame(
                capturedAt: t0.addingTimeInterval(30),
                appName: "Xcode",
                windowTitle: "Editor",
                contentHash: "hash-2",
                rawPayload: "payload-2",
                mockedText: "mcp search chunk"
            )
        )

        try pipeline.flush()

        let results = try store.searchChunks(query: "baseline", limit: 10, appFilter: nil)

        #expect(results.count == 1)
        #expect(results[0].text.contains("offline search baseline"))
        #expect(results[0].text.contains("mcp search chunk"))
        #expect(try store.countFrames() == 2)
        #expect(try store.countChunks() == 1)
    }

    @Test("重复hash的frame应被去重")
    func shouldDeduplicateFramesByHash() throws {
        let dbURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("recaply-sense-dedup-\(UUID().uuidString).sqlite")

        let store = try MemoryStore(databaseURL: dbURL)
        try store.bootstrapSchema()

        let pipeline = OfflinePipeline(
            store: store,
            ocrProvider: StubOCRProvider(),
            windowSize: 120
        )

        let t0 = Date(timeIntervalSince1970: 1_700_000_000)
        let frame = CapturedFrame(
            capturedAt: t0,
            appName: "Terminal",
            windowTitle: "Session",
            contentHash: "same-hash",
            rawPayload: "payload",
            mockedText: "same text"
        )

        try pipeline.ingest(frame: frame)
        try pipeline.ingest(frame: frame)
        try pipeline.flush()

        #expect(try store.countFrames() == 1)
        #expect(try store.countChunks() == 1)
    }
}

private struct StubOCRProvider: OCRProvider {
    func recognize(frame: CapturedFrame) throws -> String {
        frame.mockedText
    }
}
