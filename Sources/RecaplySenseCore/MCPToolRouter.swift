import Foundation

public struct CitationOutput: Codable, Sendable {
    public let type: String
    public let id: String
    public let start_ts: Int64
    public let end_ts: Int64
    public let app: String
    public let window: String

    public init(type: String, id: String, start_ts: Int64, end_ts: Int64, app: String, window: String) {
        self.type = type
        self.id = id
        self.start_ts = start_ts
        self.end_ts = end_ts
        self.app = app
        self.window = window
    }
}

public struct SearchToolItem: Codable, Sendable {
    public let id: String
    public let text: String
    public let citation: CitationOutput

    public init(id: String, text: String, citation: CitationOutput) {
        self.id = id
        self.text = text
        self.citation = citation
    }
}

public struct SearchToolOutput: Codable, Sendable {
    public let items: [SearchToolItem]

    public init(items: [SearchToolItem]) {
        self.items = items
    }
}

public struct GetChunkToolOutput: Codable, Sendable {
    public let id: String
    public let text: String
    public let start_ts: Int64
    public let end_ts: Int64
    public let app: String
    public let window: String

    public init(id: String, text: String, start_ts: Int64, end_ts: Int64, app: String, window: String) {
        self.id = id
        self.text = text
        self.start_ts = start_ts
        self.end_ts = end_ts
        self.app = app
        self.window = window
    }
}

public final class MCPToolRouter {
    private let store: MemoryStore

    public init(store: MemoryStore) {
        self.store = store
    }

    public func recapsenseSearch(query: String, limit: Int, appFilter: String?) throws -> SearchToolOutput {
        let records = try store.searchChunks(query: query, limit: limit, appFilter: appFilter)
        let items = records.map { record in
            SearchToolItem(
                id: String(record.id),
                text: record.text,
                citation: CitationOutput(
                    type: "chunk",
                    id: String(record.id),
                    start_ts: Int64(record.startAt.timeIntervalSince1970),
                    end_ts: Int64(record.endAt.timeIntervalSince1970),
                    app: record.appName,
                    window: record.windowTitle
                )
            )
        }

        return SearchToolOutput(items: items)
    }

    public func recapsenseGetChunk(id: Int64) throws -> GetChunkToolOutput {
        guard let record = try store.getChunk(id: id) else {
            throw RecaplySenseError.invalidState(message: "Chunk \(id) does not exist")
        }

        return GetChunkToolOutput(
            id: String(record.id),
            text: record.text,
            start_ts: Int64(record.startAt.timeIntervalSince1970),
            end_ts: Int64(record.endAt.timeIntervalSince1970),
            app: record.appName,
            window: record.windowTitle
        )
    }
}
