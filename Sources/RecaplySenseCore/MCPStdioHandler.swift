import Foundation

public struct MCPStdioHandler {
    private let router: MCPToolRouter

    public init(router: MCPToolRouter) {
        self.router = router
    }

    public func handle(line: String) throws -> String {
        guard let data = line.data(using: .utf8) else {
            return #"{"error":"invalid utf8"}"#
        }

        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tool = object["tool"] as? String else {
            return #"{"error":"invalid request"}"#
        }

        let arguments = object["arguments"] as? [String: Any] ?? [:]

        switch tool {
        case "recapsense_search":
            let query = (arguments["query"] as? String) ?? ""
            let limit = (arguments["limit"] as? Int) ?? 10
            let appFilter = arguments["app"] as? String
            let result = try router.recapsenseSearch(query: query, limit: limit, appFilter: appFilter)
            return try jsonString(from: result)

        case "recapsense_get_chunk":
            guard let idNumber = arguments["id"] as? NSNumber else {
                return #"{"error":"missing id"}"#
            }
            let result = try router.recapsenseGetChunk(id: idNumber.int64Value)
            return try jsonString(from: result)

        default:
            return #"{"error":"tool not found"}"#
        }
    }

    private func jsonString<T: Encodable>(from value: T) throws -> String {
        let data = try JSONEncoder().encode(value)
        return String(data: data, encoding: .utf8) ?? "{}"
    }
}
