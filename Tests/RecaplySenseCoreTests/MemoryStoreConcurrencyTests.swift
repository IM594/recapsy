import Foundation
import Testing
@testable import RecaplySenseCore

struct MemoryStoreConcurrencyTests {
    @Test("MemoryStore 并发读写后应保持一致")
    func shouldRemainConsistentUnderConcurrentReadWrite() throws {
        let dbURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("recaply-sense-concurrency-\(UUID().uuidString).sqlite")

        let store = try MemoryStore(databaseURL: dbURL)
        try store.bootstrapSchema()

        DispatchQueue.concurrentPerform(iterations: 100) { index in
            let capturedAt = Date(timeIntervalSince1970: 1_700_000_000 + TimeInterval(index))
            let frame = FrameInsert(
                capturedAt: capturedAt,
                appName: "App\(index % 3)",
                windowTitle: "Window\(index)",
                ocrText: "Text \(index)",
                contentHash: "hash-\(index)",
                mediaPath: nil
            )
            _ = try? store.insertFrame(frame)
            _ = try? store.countFrames()
        }

        #expect(try store.countFrames() == 100)
    }

    @Test("MemoryStore 写入失败后仍可恢复并继续读写")
    func shouldRecoverAfterWriteFailure() throws {
        let dbURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("recaply-sense-concurrency-failure-\(UUID().uuidString).sqlite")

        let store = try MemoryStore(databaseURL: dbURL)

        #expect(throws: RecaplySenseError.self) {
            _ = try store.insertFrame(
                FrameInsert(
                    capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
                    appName: "Notes",
                    windowTitle: "Untitled",
                    ocrText: "hello",
                    contentHash: "hash-before-bootstrap",
                    mediaPath: nil
                )
            )
        }

        try store.bootstrapSchema()
        _ = try store.insertFrame(
            FrameInsert(
                capturedAt: Date(timeIntervalSince1970: 1_700_000_100),
                appName: "Notes",
                windowTitle: "Untitled",
                ocrText: "world",
                contentHash: "hash-after-bootstrap",
                mediaPath: nil
            )
        )

        #expect(try store.countFrames() == 1)
    }
}
