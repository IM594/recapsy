import Foundation
import Testing
@testable import RecaplySenseCore

struct MCPToolsTests {
    @Test("MCP search 与 get_chunk 工具应返回可追溯字段")
    func shouldExposeSearchAndGetChunkTools() throws {
        let dbURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("recaply-sense-mcp-\(UUID().uuidString).sqlite")

        let store = try MemoryStore(databaseURL: dbURL)
        try store.bootstrapSchema()

        let chunkID = try store.insertChunk(
            ChunkInsert(
                startAt: Date(timeIntervalSince1970: 1_700_000_000),
                endAt: Date(timeIntervalSince1970: 1_700_000_120),
                text: "mcp keyword for search",
                appName: "Safari",
                windowTitle: "Docs"
            )
        )

        let router = MCPToolRouter(store: store)

        let searchOutput = try router.recapsenseSearch(
            query: "keyword",
            limit: 5,
            appFilter: nil
        )

        #expect(searchOutput.items.count == 1)
        #expect(searchOutput.items[0].citation.type == "chunk")
        #expect(searchOutput.items[0].citation.id == String(chunkID))

        let chunkOutput = try router.recapsenseGetChunk(id: chunkID)

        #expect(chunkOutput.id == String(chunkID))
        #expect(chunkOutput.text.contains("keyword"))
        #expect(chunkOutput.app == "Safari")
    }
}
