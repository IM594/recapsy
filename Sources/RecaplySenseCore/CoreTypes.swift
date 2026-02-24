import Foundation

public enum RecaplySenseError: Error, LocalizedError {
    case sqlite(message: String)
    case invalidState(message: String)
    case capture(message: String)
    case ocr(message: String)

    public var errorDescription: String? {
        switch self {
        case .sqlite(let message):
            return "SQLite error: \(message)"
        case .invalidState(let message):
            return "Invalid state: \(message)"
        case .capture(let message):
            return "Capture error: \(message)"
        case .ocr(let message):
            return "OCR error: \(message)"
        }
    }
}

public struct CapturedFrame: Sendable {
    public let capturedAt: Date
    public let appName: String
    public let windowTitle: String
    public let contentHash: String
    public let rawPayload: String
    public let mockedText: String
    public let imagePath: String?

    public init(
        capturedAt: Date,
        appName: String,
        windowTitle: String,
        contentHash: String,
        rawPayload: String = "",
        mockedText: String = "",
        imagePath: String? = nil
    ) {
        self.capturedAt = capturedAt
        self.appName = appName
        self.windowTitle = windowTitle
        self.contentHash = contentHash
        self.rawPayload = rawPayload
        self.mockedText = mockedText
        self.imagePath = imagePath
    }
}

public protocol OCRProvider {
    func recognize(frame: CapturedFrame) throws -> String
}

public struct FrameInsert: Sendable {
    public let capturedAt: Date
    public let appName: String
    public let windowTitle: String
    public let ocrText: String
    public let contentHash: String
    public let mediaPath: String?

    public init(
        capturedAt: Date,
        appName: String,
        windowTitle: String,
        ocrText: String,
        contentHash: String,
        mediaPath: String? = nil
    ) {
        self.capturedAt = capturedAt
        self.appName = appName
        self.windowTitle = windowTitle
        self.ocrText = ocrText
        self.contentHash = contentHash
        self.mediaPath = mediaPath
    }
}

public struct ChunkInsert: Sendable {
    public let startAt: Date
    public let endAt: Date
    public let text: String
    public let appName: String
    public let windowTitle: String

    public init(
        startAt: Date,
        endAt: Date,
        text: String,
        appName: String,
        windowTitle: String
    ) {
        self.startAt = startAt
        self.endAt = endAt
        self.text = text
        self.appName = appName
        self.windowTitle = windowTitle
    }
}

public struct ChunkRecord: Sendable {
    public let id: Int64
    public let startAt: Date
    public let endAt: Date
    public let text: String
    public let appName: String
    public let windowTitle: String

    public init(
        id: Int64,
        startAt: Date,
        endAt: Date,
        text: String,
        appName: String,
        windowTitle: String
    ) {
        self.id = id
        self.startAt = startAt
        self.endAt = endAt
        self.text = text
        self.appName = appName
        self.windowTitle = windowTitle
    }
}
