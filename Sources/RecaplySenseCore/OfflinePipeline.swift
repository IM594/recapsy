import Foundation

public final class OfflinePipeline {
    private let store: MemoryStore
    private let ocrProvider: OCRProvider
    private let windowSize: TimeInterval

    private var seenHashes: Set<String> = []
    private var currentChunk: ChunkBuffer?

    public init(store: MemoryStore, ocrProvider: OCRProvider, windowSize: TimeInterval) {
        self.store = store
        self.ocrProvider = ocrProvider
        self.windowSize = windowSize
    }

    public func ingest(frame: CapturedFrame) throws {
        guard seenHashes.insert(frame.contentHash).inserted else {
            return
        }

        let text = try ocrProvider.recognize(frame: frame)
        let frameInsert = FrameInsert(
            capturedAt: frame.capturedAt,
            appName: frame.appName,
            windowTitle: frame.windowTitle,
            ocrText: text,
            contentHash: frame.contentHash,
            mediaPath: frame.imagePath
        )
        _ = try store.insertFrame(frameInsert)

        if currentChunk == nil {
            currentChunk = ChunkBuffer(
                startAt: frame.capturedAt,
                endAt: frame.capturedAt,
                appName: frame.appName,
                windowTitle: frame.windowTitle,
                texts: [text]
            )
            return
        }

        guard var buffer = currentChunk else {
            return
        }

        if frame.capturedAt.timeIntervalSince(buffer.startAt) < windowSize {
            buffer.endAt = frame.capturedAt
            buffer.texts.append(text)
            currentChunk = buffer
            return
        }

        try persistChunk(buffer)
        currentChunk = ChunkBuffer(
            startAt: frame.capturedAt,
            endAt: frame.capturedAt,
            appName: frame.appName,
            windowTitle: frame.windowTitle,
            texts: [text]
        )
    }

    public func flush() throws {
        guard let buffer = currentChunk else {
            return
        }
        try persistChunk(buffer)
        currentChunk = nil
    }

    private func persistChunk(_ buffer: ChunkBuffer) throws {
        let insert = ChunkInsert(
            startAt: buffer.startAt,
            endAt: buffer.endAt,
            text: buffer.texts.joined(separator: "\n"),
            appName: buffer.appName,
            windowTitle: buffer.windowTitle
        )
        _ = try store.insertChunk(insert)
    }
}

private struct ChunkBuffer {
    var startAt: Date
    var endAt: Date
    let appName: String
    let windowTitle: String
    var texts: [String]
}
