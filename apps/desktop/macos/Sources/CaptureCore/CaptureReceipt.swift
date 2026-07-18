import Foundation

/// Durable handoff record for a screenshot that has been written by the
/// helper but has not yet received a main-process ACK. The receipt is written
/// before the staged image is promoted to its final name, so a helper crash
/// cannot turn a valid capture into an unowned file with no recovery path.
public struct CaptureReceipt: Codable {
    public static let currentSchemaVersion = 1

    public let schemaVersion: Int
    public let workspaceId: String
    public let deviceId: String
    public let payload: CaptureResultPayload
    public let screenshotHash: String
    public let screenshotSizeBytes: Int

    public init(
        workspaceId: String,
        deviceId: String,
        payload: CaptureResultPayload,
        screenshotHash: String,
        screenshotSizeBytes: Int
    ) {
        self.schemaVersion = Self.currentSchemaVersion
        self.workspaceId = workspaceId
        self.deviceId = deviceId
        self.payload = payload
        self.screenshotHash = screenshotHash
        self.screenshotSizeBytes = screenshotSizeBytes
    }
}

public enum CaptureReceiptError: Error {
    case invalidReceipt
    case missingScreenshot
    case screenshotMismatch
}

/// File operations for the helper's receipt protocol. The methods deliberately
/// use the same capture-scoped paths as `CaptureAsset`, so recovery never
/// accepts a path supplied by a renderer or a remote service.
public enum CaptureReceiptStore {
    public static let receiptFileName = "capture.receipt.json"
    public static let stagedScreenshotFileName = "screenshot.webp.pending"

    public static func receiptURL(assetRoot: URL, captureId: String) -> URL {
        CaptureAsset.captureDirectoryURL(assetRoot: assetRoot, captureId: captureId)
            .appendingPathComponent(receiptFileName, isDirectory: false)
    }

    public static func stagedScreenshotFileURL(assetRoot: URL, captureId: String) -> URL {
        CaptureAsset.captureDirectoryURL(assetRoot: assetRoot, captureId: captureId)
            .appendingPathComponent(stagedScreenshotFileName, isDirectory: false)
    }

    public static func write(
        _ receipt: CaptureReceipt,
        assetRoot: URL,
        captureId: String
    ) throws {
        let directory = CaptureAsset.captureDirectoryURL(assetRoot: assetRoot, captureId: captureId)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(receipt)
        try data.write(to: receiptURL(assetRoot: assetRoot, captureId: captureId), options: .atomic)
    }

    public static func read(
        assetRoot: URL,
        captureId: String
    ) throws -> CaptureReceipt {
        let data = try Data(contentsOf: receiptURL(assetRoot: assetRoot, captureId: captureId))
        let receipt = try JSONDecoder().decode(CaptureReceipt.self, from: data)
        guard
            receipt.schemaVersion == CaptureReceipt.currentSchemaVersion,
            receipt.payload.captureId == captureId,
            !receipt.workspaceId.isEmpty,
            !receipt.deviceId.isEmpty,
            let app = receipt.payload.context.app,
            CaptureApplicationPayload.fromRuntimeMetadata(
                name: app.name,
                bundleId: app.bundleId
            ) == app
        else {
            throw CaptureReceiptError.invalidReceipt
        }
        return receipt
    }

    /// Promotes a staged screenshot, or validates the already-promoted final
    /// file, and returns the receipt payload ready to replay on the wire.
    public static func recover(
        _ receipt: CaptureReceipt,
        assetRoot: URL
    ) throws -> CaptureResultPayload {
        let captureId = receipt.payload.captureId
        let staged = stagedScreenshotFileURL(assetRoot: assetRoot, captureId: captureId)
        let final = CaptureAsset.screenshotFileURL(assetRoot: assetRoot, captureId: captureId)
        let fileManager = FileManager.default

        if !fileManager.fileExists(atPath: final.path) {
            guard fileManager.fileExists(atPath: staged.path) else {
                throw CaptureReceiptError.missingScreenshot
            }
            try fileManager.moveItem(at: staged, to: final)
        } else if fileManager.fileExists(atPath: staged.path) {
            // A previous recovery may have completed the promotion before the
            // process crashed again. The final file is authoritative; discard
            // only the uncommitted staging copy.
            try? fileManager.removeItem(at: staged)
        }

        guard
            let data = try? Data(contentsOf: final),
            data.count == receipt.screenshotSizeBytes,
            CaptureAsset.contentHash(for: data) == receipt.screenshotHash
        else {
            throw CaptureReceiptError.screenshotMismatch
        }
        return receipt.payload
    }

    public static func removeReceipt(assetRoot: URL, captureId: String) {
        try? FileManager.default.removeItem(at: receiptURL(assetRoot: assetRoot, captureId: captureId))
    }

    public static func removeCapture(assetRoot: URL, captureId: String) {
        try? FileManager.default.removeItem(
            at: CaptureAsset.captureDirectoryURL(assetRoot: assetRoot, captureId: captureId)
        )
    }

    public static func listCaptureIds(assetRoot: URL) -> [String] {
        guard
            let entries = try? FileManager.default.contentsOfDirectory(
                at: assetRoot,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]
            )
        else {
            return []
        }

        return entries.compactMap { entry in
            guard
                (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true,
                FileManager.default.fileExists(
                    atPath: entry.appendingPathComponent(receiptFileName).path
                )
            else {
                return nil
            }
            return entry.lastPathComponent
        }.sorted()
    }
}
