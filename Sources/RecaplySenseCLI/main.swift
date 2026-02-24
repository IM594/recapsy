import Foundation
import RecaplySenseCore

private enum CLIError: Error {
    case invalidArguments(String)
}

private func run() throws {
    var args = CommandLine.arguments
    _ = args.removeFirst()

    guard let command = args.first else {
        printUsage()
        return
    }

    switch command {
    case "bootstrap-db":
        guard args.count >= 2 else {
            throw CLIError.invalidArguments("bootstrap-db 需要 dbPath")
        }
        let dbPath = args[1]
        let store = try MemoryStore(databaseURL: URL(fileURLWithPath: dbPath))
        try store.bootstrapSchema()
        print("bootstrap complete: \(dbPath)")

    case "search":
        guard args.count >= 3 else {
            throw CLIError.invalidArguments("search 需要 dbPath 与 query")
        }
        let dbPath = args[1]
        let query = args[2]
        let store = try MemoryStore(databaseURL: URL(fileURLWithPath: dbPath))
        try store.bootstrapSchema()

        let router = MCPToolRouter(store: store)
        let output = try router.recapsenseSearch(query: query, limit: 10, appFilter: nil)
        let data = try JSONEncoder().encode(output)
        if let text = String(data: data, encoding: .utf8) {
            print(text)
        }

    case "mcp-stdio":
        guard args.count >= 2 else {
            throw CLIError.invalidArguments("mcp-stdio 需要 dbPath")
        }
        let dbPath = args[1]
        try runMCPStdio(dbPath: dbPath)

    default:
        throw CLIError.invalidArguments("不支持的命令: \(command)")
    }
}

private func runMCPStdio(dbPath: String) throws {
    let store = try MemoryStore(databaseURL: URL(fileURLWithPath: dbPath))
    try store.bootstrapSchema()
    let router = MCPToolRouter(store: store)

    while let line = readLine() {
        let response = try handleMCPLine(line: line, router: router)
        print(response)
        fflush(stdout)
    }
}

private func handleMCPLine(line: String, router: MCPToolRouter) throws -> String {
    guard let data = line.data(using: .utf8) else {
        return #"{"error":"invalid utf8"}"#
    }

    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let tool = object["tool"] as? String else {
        return #"{"error":"invalid request"}"#
    }

    let args = object["arguments"] as? [String: Any] ?? [:]

    switch tool {
    case "recapsense_search":
        let query = (args["query"] as? String) ?? ""
        let limit = (args["limit"] as? Int) ?? 10
        let appFilter = args["app"] as? String
        let result = try router.recapsenseSearch(query: query, limit: limit, appFilter: appFilter)
        return try jsonString(from: result)

    case "recapsense_get_chunk":
        guard let idNumber = args["id"] as? NSNumber else {
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

private func printUsage() {
    print("""
    RecaplySenseCLI commands:
      bootstrap-db <dbPath>
      search <dbPath> <query>
      mcp-stdio <dbPath>
    """)
}

do {
    try run()
} catch {
    fputs("[RecaplySenseCLI] \(error)\n", stderr)
    exit(1)
}
