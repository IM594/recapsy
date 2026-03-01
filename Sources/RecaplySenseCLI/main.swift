import Foundation
import RecaplySenseCore

private enum CLIError: Error {
    case invalidArguments(String)
}

private func run() throws {
    var args = CommandLine.arguments
    _ = args.removeFirst()

    guard let command = args.first else {
        MenuBarAppMain.run()
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

    case "capture-once":
        guard args.count >= 2 else {
            throw CLIError.invalidArguments("capture-once 需要 dbPath")
        }
        let dbPath = args[1]
        try runCaptureOnce(dbPath: dbPath)

    case "mcp-stdio":
        guard args.count >= 2 else {
            throw CLIError.invalidArguments("mcp-stdio 需要 dbPath")
        }
        let dbPath = args[1]
        try runMCPStdio(dbPath: dbPath)

    case "help", "--help", "-h":
        printUsage()

    default:
        throw CLIError.invalidArguments("不支持的命令: \(command)")
    }
}

private func runCaptureOnce(dbPath: String) throws {
    let dbURL = URL(fileURLWithPath: dbPath)
    let mediaDirectory = dbURL.deletingLastPathComponent().appendingPathComponent("media")

    let runtime = try AppRuntimeBuilder.build(
        databaseURL: dbURL,
        mediaDirectory: mediaDirectory
    )

    let captured = try runtime.captureService.captureOnce()
    try runtime.captureService.stopAndFlush()

    if captured {
        print("capture complete: 1 frame ingested")
    } else {
        print("capture skipped: no eligible frontmost window")
    }
}

private func runMCPStdio(dbPath: String) throws {
    let store = try MemoryStore(databaseURL: URL(fileURLWithPath: dbPath))
    try store.bootstrapSchema()
    let handler = MCPStdioHandler(router: MCPToolRouter(store: store))

    while let line = readLine() {
        let response = try handler.handle(line: line)
        print(response)
        fflush(stdout)
    }
}

private func printUsage() {
    print("""
    RecaplySenseCLI commands:
      (no args)              launch menu bar app shell
      bootstrap-db <dbPath>
      search <dbPath> <query>
      capture-once <dbPath>
      mcp-stdio <dbPath>
      help
    """)
}

do {
    try run()
} catch {
    fputs("[RecaplySenseCLI] \(error)\n", stderr)
    exit(1)
}
