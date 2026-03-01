import Foundation
import SQLite3

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

public final class MemoryStore {
    private let databaseURL: URL
    private var db: OpaquePointer?

    public init(databaseURL: URL) throws {
        self.databaseURL = databaseURL
        try FileManager.default.createDirectory(
            at: databaseURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try openDatabase()
    }

    deinit {
        sqlite3_close(db)
    }

    public func bootstrapSchema() throws {
        try execute(sql: "PRAGMA journal_mode=WAL;")

        try execute(sql: """
            CREATE TABLE IF NOT EXISTS frames (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                captured_at INTEGER NOT NULL,
                app TEXT NOT NULL,
                window TEXT NOT NULL,
                ocr_text TEXT NOT NULL,
                media_path TEXT,
                hash TEXT NOT NULL UNIQUE
            );
            """)

        try execute(sql: """
            CREATE TABLE IF NOT EXISTS chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                start_at INTEGER NOT NULL,
                end_at INTEGER NOT NULL,
                text TEXT NOT NULL,
                app TEXT NOT NULL,
                window TEXT NOT NULL,
                score_fields TEXT DEFAULT '{}'
            );
            """)

        try execute(sql: """
            CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
            USING fts5(text, content='chunks', content_rowid='id');
            """)

        try execute(sql: """
            CREATE TABLE IF NOT EXISTS audio_segments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                start_at INTEGER NOT NULL,
                end_at INTEGER NOT NULL,
                text TEXT NOT NULL,
                speaker TEXT,
                media_path TEXT
            );
            """)

        try execute(sql: """
            CREATE TABLE IF NOT EXISTS embeddings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                provider TEXT NOT NULL,
                dim INTEGER NOT NULL,
                vector_blob BLOB,
                updated_at INTEGER NOT NULL,
                UNIQUE(entity_type, entity_id)
            );
            """)

        try execute(sql: """
            CREATE TABLE IF NOT EXISTS summaries_daily (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL UNIQUE,
                summary TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            """)

        try execute(sql: """
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            """)

        try execute(sql: """
            CREATE TABLE IF NOT EXISTS sync_outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                idempotency_key TEXT NOT NULL UNIQUE,
                retries INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                created_at INTEGER NOT NULL
            );
            """)

        try execute(sql: """
            CREATE TABLE IF NOT EXISTS sync_cursor (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL UNIQUE,
                cursor TEXT NOT NULL,
                version TEXT,
                updated_at INTEGER NOT NULL
            );
            """)

        try execute(sql: "CREATE INDEX IF NOT EXISTS idx_frames_captured_at ON frames(captured_at);")
        try execute(sql: "CREATE INDEX IF NOT EXISTS idx_frames_app ON frames(app);")
        try execute(sql: "CREATE INDEX IF NOT EXISTS idx_chunks_start_at ON chunks(start_at);")
        try execute(sql: "CREATE INDEX IF NOT EXISTS idx_chunks_app ON chunks(app);")
    }

    public func listTables() throws -> [String] {
        let sql = "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') OR type='virtual table';"
        let rows = try query(sql: sql, binder: { _ in })
        return rows.compactMap { $0["name"] }
    }

    @discardableResult
    public func insertFrame(_ frame: FrameInsert) throws -> Int64 {
        let sql = """
            INSERT OR IGNORE INTO frames(captured_at, app, window, ocr_text, media_path, hash)
            VALUES (?, ?, ?, ?, ?, ?);
            """

        let timestamp = Int64(frame.capturedAt.timeIntervalSince1970)
        try step(sql: sql) { statement in
            sqlite3_bind_int64(statement, 1, timestamp)
            sqlite3_bind_text(statement, 2, frame.appName, -1, SQLITE_TRANSIENT)
            sqlite3_bind_text(statement, 3, frame.windowTitle, -1, SQLITE_TRANSIENT)
            sqlite3_bind_text(statement, 4, frame.ocrText, -1, SQLITE_TRANSIENT)
            if let mediaPath = frame.mediaPath {
                sqlite3_bind_text(statement, 5, mediaPath, -1, SQLITE_TRANSIENT)
            } else {
                sqlite3_bind_null(statement, 5)
            }
            sqlite3_bind_text(statement, 6, frame.contentHash, -1, SQLITE_TRANSIENT)
        }

        let rowID = sqlite3_last_insert_rowid(db)
        if rowID > 0 {
            return rowID
        }

        return try findFrameID(byHash: frame.contentHash)
    }

    @discardableResult
    public func insertChunk(_ chunk: ChunkInsert) throws -> Int64 {
        let insertChunkSQL = """
            INSERT INTO chunks(start_at, end_at, text, app, window)
            VALUES (?, ?, ?, ?, ?);
            """

        let start = Int64(chunk.startAt.timeIntervalSince1970)
        let end = Int64(chunk.endAt.timeIntervalSince1970)

        try step(sql: insertChunkSQL) { statement in
            sqlite3_bind_int64(statement, 1, start)
            sqlite3_bind_int64(statement, 2, end)
            sqlite3_bind_text(statement, 3, chunk.text, -1, SQLITE_TRANSIENT)
            sqlite3_bind_text(statement, 4, chunk.appName, -1, SQLITE_TRANSIENT)
            sqlite3_bind_text(statement, 5, chunk.windowTitle, -1, SQLITE_TRANSIENT)
        }

        let rowID = sqlite3_last_insert_rowid(db)

        let insertFTSSQL = "INSERT INTO chunks_fts(rowid, text) VALUES (?, ?);"
        try step(sql: insertFTSSQL) { statement in
            sqlite3_bind_int64(statement, 1, rowID)
            sqlite3_bind_text(statement, 2, chunk.text, -1, SQLITE_TRANSIENT)
        }

        return rowID
    }

    public func searchChunks(query: String, limit: Int, appFilter: String?) throws -> [ChunkRecord] {
        let filterSQL = appFilter == nil ? "" : "AND c.app = ?"
        let sql = """
            SELECT c.id, c.start_at, c.end_at, c.text, c.app, c.window
            FROM chunks_fts f
            JOIN chunks c ON c.id = f.rowid
            WHERE f.text MATCH ?
            \(filterSQL)
            ORDER BY c.start_at DESC
            LIMIT ?;
            """

        var records: [ChunkRecord] = []
        try withPreparedStatement(sql: sql) { statement in
            sqlite3_bind_text(statement, 1, query, -1, SQLITE_TRANSIENT)
            if let appFilter {
                sqlite3_bind_text(statement, 2, appFilter, -1, SQLITE_TRANSIENT)
                sqlite3_bind_int(statement, 3, Int32(limit))
            } else {
                sqlite3_bind_int(statement, 2, Int32(limit))
            }

            while sqlite3_step(statement) == SQLITE_ROW {
                records.append(chunkRecord(from: statement))
            }
        }

        return records
    }

    public func getChunk(id: Int64) throws -> ChunkRecord? {
        let sql = """
            SELECT id, start_at, end_at, text, app, window
            FROM chunks
            WHERE id = ?
            LIMIT 1;
            """

        var result: ChunkRecord?
        try withPreparedStatement(sql: sql) { statement in
            sqlite3_bind_int64(statement, 1, id)
            if sqlite3_step(statement) == SQLITE_ROW {
                result = chunkRecord(from: statement)
            }
        }

        return result
    }

    public func countFrames() throws -> Int {
        try scalarInt(sql: "SELECT COUNT(*) FROM frames;")
    }

    public func countChunks() throws -> Int {
        try scalarInt(sql: "SELECT COUNT(*) FROM chunks;")
    }

    public func latestFrameCapturedAt() throws -> Date? {
        let sql = "SELECT captured_at FROM frames ORDER BY captured_at DESC LIMIT 1;"
        var result: Date?
        try withPreparedStatement(sql: sql) { statement in
            if sqlite3_step(statement) == SQLITE_ROW {
                let timestamp = sqlite3_column_int64(statement, 0)
                result = Date(timeIntervalSince1970: TimeInterval(timestamp))
            }
        }
        return result
    }

    public func latestChunkPreview(maxLength: Int) throws -> String? {
        let sql = "SELECT text FROM chunks ORDER BY end_at DESC LIMIT 1;"
        var preview: String?
        try withPreparedStatement(sql: sql) { statement in
            if sqlite3_step(statement) == SQLITE_ROW,
               let textPointer = sqlite3_column_text(statement, 0) {
                let fullText = String(cString: textPointer)
                preview = String(fullText.prefix(max(0, maxLength)))
            }
        }
        return preview
    }

    public func latestFrameOCRPreview(maxLength: Int) throws -> String? {
        let sql = "SELECT ocr_text FROM frames ORDER BY captured_at DESC LIMIT 1;"
        var preview: String?
        try withPreparedStatement(sql: sql) { statement in
            if sqlite3_step(statement) == SQLITE_ROW,
               let textPointer = sqlite3_column_text(statement, 0) {
                let fullText = String(cString: textPointer)
                preview = String(fullText.prefix(max(0, maxLength)))
            }
        }
        return preview
    }

    private func openDatabase() throws {
        if sqlite3_open(databaseURL.path, &db) != SQLITE_OK {
            throw RecaplySenseError.sqlite(message: sqliteErrorMessage())
        }
    }

    private func execute(sql: String) throws {
        var errorPointer: UnsafeMutablePointer<Int8>?
        if sqlite3_exec(db, sql, nil, nil, &errorPointer) != SQLITE_OK {
            let message = errorPointer.flatMap { String(cString: $0) } ?? sqliteErrorMessage()
            sqlite3_free(errorPointer)
            throw RecaplySenseError.sqlite(message: message)
        }
    }

    private func step(sql: String, binder: (OpaquePointer) -> Void) throws {
        try withPreparedStatement(sql: sql) { statement in
            binder(statement)
            if sqlite3_step(statement) != SQLITE_DONE {
                throw RecaplySenseError.sqlite(message: sqliteErrorMessage())
            }
        }
    }

    private func query(sql: String, binder: (OpaquePointer) -> Void) throws -> [[String: String]] {
        var rows: [[String: String]] = []
        try withPreparedStatement(sql: sql) { statement in
            binder(statement)
            while sqlite3_step(statement) == SQLITE_ROW {
                var row: [String: String] = [:]
                let count = sqlite3_column_count(statement)
                for index in 0..<count {
                    let name = String(cString: sqlite3_column_name(statement, index))
                    if let valuePointer = sqlite3_column_text(statement, index) {
                        row[name] = String(cString: valuePointer)
                    } else {
                        row[name] = ""
                    }
                }
                rows.append(row)
            }
        }
        return rows
    }

    private func scalarInt(sql: String) throws -> Int {
        var value = 0
        try withPreparedStatement(sql: sql) { statement in
            if sqlite3_step(statement) == SQLITE_ROW {
                value = Int(sqlite3_column_int(statement, 0))
            }
        }
        return value
    }

    private func withPreparedStatement(sql: String, _ body: (OpaquePointer) throws -> Void) throws {
        var statement: OpaquePointer?
        if sqlite3_prepare_v2(db, sql, -1, &statement, nil) != SQLITE_OK {
            throw RecaplySenseError.sqlite(message: sqliteErrorMessage())
        }

        guard let statement else {
            throw RecaplySenseError.invalidState(message: "Cannot allocate SQLite statement")
        }

        defer {
            sqlite3_finalize(statement)
        }

        try body(statement)
    }

    private func findFrameID(byHash hash: String) throws -> Int64 {
        let sql = "SELECT id FROM frames WHERE hash = ? LIMIT 1;"
        var frameID: Int64 = 0

        try withPreparedStatement(sql: sql) { statement in
            sqlite3_bind_text(statement, 1, hash, -1, SQLITE_TRANSIENT)
            if sqlite3_step(statement) == SQLITE_ROW {
                frameID = sqlite3_column_int64(statement, 0)
            }
        }

        return frameID
    }

    private func chunkRecord(from statement: OpaquePointer) -> ChunkRecord {
        let id = sqlite3_column_int64(statement, 0)
        let startAt = Date(timeIntervalSince1970: TimeInterval(sqlite3_column_int64(statement, 1)))
        let endAt = Date(timeIntervalSince1970: TimeInterval(sqlite3_column_int64(statement, 2)))
        let text = String(cString: sqlite3_column_text(statement, 3))
        let app = String(cString: sqlite3_column_text(statement, 4))
        let window = String(cString: sqlite3_column_text(statement, 5))

        return ChunkRecord(
            id: id,
            startAt: startAt,
            endAt: endAt,
            text: text,
            appName: app,
            windowTitle: window
        )
    }

    private func sqliteErrorMessage() -> String {
        if let db, let cString = sqlite3_errmsg(db) {
            return String(cString: cString)
        }
        return "unknown"
    }
}
