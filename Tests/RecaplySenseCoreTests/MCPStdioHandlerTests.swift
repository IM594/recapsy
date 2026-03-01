import Foundation
import Testing
@testable import RecaplySenseCore

struct MCPStdioHandlerTests {
    @Test("MCPStdioHandler 应处理 recapsense_search 主路径")
    func shouldHandleSearchRequest() throws {
        let dbURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("recaply-sense-stdio-search-\(UUID().uuidString).sqlite")

        let store = try MemoryStore(databaseURL: dbURL)
        try store.bootstrapSchema()
        let chunkID = try store.insertChunk(
            ChunkInsert(
                startAt: Date(timeIntervalSince1970: 1_700_000_000),
                endAt: Date(timeIntervalSince1970: 1_700_000_060),
                text: "stdio search keyword",
                appName: "Safari",
                windowTitle: "Docs"
            )
        )

        let handler = MCPStdioHandler(router: MCPToolRouter(store: store))
        let line = #"{"tool":"recapsense_search","arguments":{"query":"keyword","limit":5}}"#
        let response = try handler.handle(line: line)

        let object = try parseJSONObject(from: response)
        let items = try #require(object["items"] as? [[String: Any]])
        #expect(items.count == 1)
        let firstItem = try #require(items.first)
        let citation = try #require(firstItem["citation"] as? [String: Any])
        #expect(citation["id"] as? String == String(chunkID))
    }

    @Test("MCPStdioHandler 当 get_chunk 缺少 id 时返回错误")
    func shouldReturnErrorWhenGetChunkMissingID() throws {
        let dbURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("recaply-sense-stdio-missing-id-\(UUID().uuidString).sqlite")

        let store = try MemoryStore(databaseURL: dbURL)
        try store.bootstrapSchema()

        let handler = MCPStdioHandler(router: MCPToolRouter(store: store))
        let line = #"{"tool":"recapsense_get_chunk","arguments":{}}"#
        let response = try handler.handle(line: line)
        let object = try parseJSONObject(from: response)

        #expect(object["error"] as? String == "missing id")
    }

    @Test("MCPStdioHandler 对未知工具返回 tool not found")
    func shouldReturnToolNotFoundForUnknownTool() throws {
        let dbURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("recaply-sense-stdio-unknown-tool-\(UUID().uuidString).sqlite")

        let store = try MemoryStore(databaseURL: dbURL)
        try store.bootstrapSchema()

        let handler = MCPStdioHandler(router: MCPToolRouter(store: store))
        let line = #"{"tool":"unknown_tool","arguments":{}}"#
        let response = try handler.handle(line: line)
        let object = try parseJSONObject(from: response)

        #expect(object["error"] as? String == "tool not found")
    }
}

private func parseJSONObject(from text: String) throws -> [String: Any] {
    let data = try #require(text.data(using: .utf8))
    return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
}
