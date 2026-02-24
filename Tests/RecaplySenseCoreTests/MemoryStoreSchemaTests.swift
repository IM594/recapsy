import Foundation
import Testing
@testable import RecaplySenseCore

struct MemoryStoreSchemaTests {
    @Test("数据库初始化应创建核心表与FTS")
    func shouldCreateCoreTablesAndFTS() throws {
        let dbURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("recaply-sense-db-\(UUID().uuidString).sqlite")

        let store = try MemoryStore(databaseURL: dbURL)
        try store.bootstrapSchema()

        let tables = try store.listTables()

        #expect(tables.contains("frames"))
        #expect(tables.contains("chunks"))
        #expect(tables.contains("audio_segments"))
        #expect(tables.contains("embeddings"))
        #expect(tables.contains("settings"))
        #expect(tables.contains("sync_outbox"))
        #expect(tables.contains("sync_cursor"))
        #expect(tables.contains("chunks_fts"))
    }
}
