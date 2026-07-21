import Foundation

/// The policy identity that owns a durable capture artifact.
public struct CapturePolicyIdentity: Codable, Equatable {
    public let hash: String
    public let version: String

    public init(hash: String, version: String) {
        self.hash = hash
        self.version = version
    }
}

/// Identity of the exact ScreenCaptureKit window that produced an artifact.
/// Application metadata is retained because it is the only source context
/// currently allowed on the helper wire; the numeric ids bind the receipt to
/// the selected window rather than a later frontmost-app lookup.
public struct CaptureWindowIdentity: Codable, Equatable {
    public let application: CaptureApplicationPayload
    public let windowId: Int
    public let ownerProcessId: Int

    public init(application: CaptureApplicationPayload, windowId: Int, ownerProcessId: Int) {
        self.application = application
        self.windowId = windowId
        self.ownerProcessId = ownerProcessId
    }
}

/// The single durable fact for the screenshot bytes. The result payload is
/// derived from this record when it crosses the helper wire, so hash, size and
/// relative reference cannot drift between recovery and normal commit.
public struct CaptureScreenshotRecord: Codable, Equatable {
    public let ref: String
    public let hash: String
    public let mimeType: String
    public let sizeBytes: Int

    public init(ref: String, hash: String, mimeType: String, sizeBytes: Int) {
        self.ref = ref
        self.hash = hash
        self.mimeType = mimeType
        self.sizeBytes = sizeBytes
    }

    public func payload() -> CaptureAssetPayload {
        CaptureAssetPayload(
            role: "screenshot",
            ref: ref,
            hash: hash,
            mimeType: mimeType,
            sizeBytes: sizeBytes
        )
    }
}

/// Durable helper-owned handoff record. Only canonical capture facts are
/// encoded to disk; the wire payload is derived by `payload` and is never a
/// second source of truth.
public struct CaptureReceipt: Codable, Equatable {
    // Bumped for the `capturedAt` / `frameQuality` fields: a receipt written
    // by an older helper build cannot recover through a newer one anyway,
    // since both are non-optional capture-time facts.
    public static let currentSchemaVersion = 3

    public let schemaVersion: Int
    public let workspaceId: String
    public let deviceId: String
    public let captureId: String
    public let observedAt: String
    public let capturedAt: String
    public let policy: CapturePolicyIdentity
    public let source: CaptureWindowIdentity
    /// Optional because receipts written before native context sampling remain
    /// recoverable. It contains only the already-sanitized fields.
    public let sourceContext: CaptureSourceContext?
    public let screenshot: CaptureScreenshotRecord
    public let frameQuality: CaptureFrameQuality
    public let decision: String

    public init(
        workspaceId: String,
        deviceId: String,
        captureId: String,
        observedAt: String,
        capturedAt: String,
        policy: CapturePolicyIdentity,
        source: CaptureWindowIdentity,
        sourceContext: CaptureSourceContext? = nil,
        screenshot: CaptureScreenshotRecord,
        frameQuality: CaptureFrameQuality,
        decision: String
    ) {
        self.schemaVersion = Self.currentSchemaVersion
        self.workspaceId = workspaceId
        self.deviceId = deviceId
        self.captureId = captureId
        self.observedAt = observedAt
        self.capturedAt = capturedAt
        self.policy = policy
        self.source = source
        self.sourceContext = sourceContext
        self.screenshot = screenshot
        self.frameQuality = frameQuality
        self.decision = decision
    }

    /// Current helper wire contract, derived from the canonical receipt.
    public var payload: CaptureResultPayload {
        let policyPayload = CapturePolicyPayload(version: policy.version, decision: decision)
        let context = sourceContext?.payload(
            application: source.application,
            observedAt: observedAt,
            policy: policyPayload
        ) ?? CaptureContextPayload(
            app: source.application,
            observedAt: observedAt,
            policy: policyPayload
        )
        return CaptureResultPayload(
            captureId: captureId,
            observedAt: observedAt,
            capturedAt: capturedAt,
            screenshot: screenshot.payload(),
            context: context,
            frameQuality: frameQuality
        )
    }
}

public enum CaptureReceiptError: Error, Equatable {
    case invalidReceipt
    case invalidCaptureId
    case missingScreenshot
    case unreadableScreenshot
    case screenshotMismatch
    case policyMismatch
    case cleanupFailed
}

public enum CaptureArtifactKind: Equatable {
    case receipt
    /// A final screenshot without a receipt has been acknowledged by Electron
    /// and belongs to the main-process outbox, not helper recovery.
    case accepted
    case orphan
}

public struct CaptureArtifact: Equatable {
    public let captureId: String
    public let kind: CaptureArtifactKind

    public init(captureId: String, kind: CaptureArtifactKind) {
        self.captureId = captureId
        self.kind = kind
    }
}

public enum CaptureReceiptDisposition: Equatable {
    case replay
    case discardOwnerMismatch
    case discardPolicyMismatch
}

/// One validator for both the normal commit and crash recovery paths. It
/// validates metadata independently of the filesystem, then optionally checks
/// the bytes against the one canonical screenshot record.
public enum CaptureArtifactValidator {
    public static func validate(
        _ receipt: CaptureReceipt,
        captureId: String,
        expectedPolicy: CapturePolicyIdentity? = nil,
        imageData: Data? = nil
    ) throws {
        guard
            receipt.schemaVersion == CaptureReceipt.currentSchemaVersion,
            receipt.captureId == captureId,
            CaptureAsset.isSafeCaptureId(captureId),
            !receipt.workspaceId.isEmpty,
            !receipt.deviceId.isEmpty,
            isValidTimestamp(receipt.observedAt),
            isValidTimestamp(receipt.capturedAt),
            !receipt.policy.version.isEmpty,
            receipt.policy.hash.range(of: "^sha256:[a-f0-9]{64}$", options: .regularExpression) != nil,
            CaptureApplicationPayload.fromRuntimeMetadata(
                name: receipt.source.application.name,
                bundleId: receipt.source.application.bundleId
            ) == receipt.source.application,
            receipt.source.windowId > 0,
            receipt.source.ownerProcessId > 0,
            receipt.screenshot.ref == CaptureAsset.screenshotRelativeKey(captureId: captureId),
            receipt.screenshot.mimeType == CaptureAsset.screenshotMimeType,
            receipt.screenshot.hash.range(of: "^sha256:[a-f0-9]{64}$", options: .regularExpression) != nil,
            receipt.screenshot.sizeBytes > 0,
            ["allow", "redact_context", "block_ocr"].contains(receipt.decision)
        else {
            throw CaptureReceiptError.invalidReceipt
        }

        if let expectedPolicy, receipt.policy != expectedPolicy {
            throw CaptureReceiptError.policyMismatch
        }
        if let imageData {
            guard
                imageData.count == receipt.screenshot.sizeBytes,
                CaptureAsset.contentHash(for: imageData) == receipt.screenshot.hash
            else {
                throw CaptureReceiptError.screenshotMismatch
            }
        }
    }

    private static func isValidTimestamp(_ value: String) -> Bool {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if formatter.date(from: value) != nil {
            return true
        }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value) != nil
    }
}

/// File operations for the helper's receipt protocol. The methods deliberately
/// use the same capture-scoped paths as `CaptureAsset`, so recovery never
/// accepts a path supplied by a renderer or a remote service.
public enum CaptureArtifactStore {
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
        try validateCaptureId(captureId)
        try CaptureArtifactValidator.validate(receipt, captureId: captureId)
        _ = try validatedDirectory(assetRoot: assetRoot, captureId: captureId)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(receipt)
        try data.write(to: receiptURL(assetRoot: assetRoot, captureId: captureId), options: .atomic)
    }

    public static func read(
        assetRoot: URL,
        captureId: String
    ) throws -> CaptureReceipt {
        try validateCaptureId(captureId)
        let directory = try validatedDirectory(assetRoot: assetRoot, captureId: captureId)
        let receiptURL = directory.appendingPathComponent(receiptFileName, isDirectory: false)
        let receiptValues = try receiptURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        guard receiptValues.isRegularFile == true, receiptValues.isSymbolicLink != true else {
            throw CaptureReceiptError.invalidReceipt
        }
        let data = try Data(contentsOf: receiptURL)
        let receipt: CaptureReceipt
        do {
            receipt = try JSONDecoder().decode(CaptureReceipt.self, from: data)
        } catch {
            throw CaptureReceiptError.invalidReceipt
        }
        try CaptureArtifactValidator.validate(receipt, captureId: captureId)
        return receipt
    }

    /// Promotes the highest-integrity copy. A valid final file wins; when it
    /// is invalid, a valid staged file replaces it. No copy is deleted until
    /// the other copy has been verified against the canonical receipt.
    public static func recover(
        _ receipt: CaptureReceipt,
        assetRoot: URL,
        expectedPolicy: CapturePolicyIdentity? = nil
    ) throws -> CaptureResultPayload {
        let captureId = receipt.captureId
        try validateCaptureId(captureId)
        try CaptureArtifactValidator.validate(
            receipt,
            captureId: captureId,
            expectedPolicy: expectedPolicy
        )
        _ = try validatedDirectory(assetRoot: assetRoot, captureId: captureId)

        let staged = stagedScreenshotFileURL(assetRoot: assetRoot, captureId: captureId)
        let final = CaptureAsset.screenshotFileURL(assetRoot: assetRoot, captureId: captureId)
        let fileManager = FileManager.default
        let stagedState = inspect(staged, receipt: receipt, expectedPolicy: expectedPolicy)
        let finalState = inspect(final, receipt: receipt, expectedPolicy: expectedPolicy)
        guard !stagedState.isUnreadable, !finalState.isUnreadable else {
            throw CaptureReceiptError.unreadableScreenshot
        }

        if finalState.isValid {
            if !stagedState.isMissing {
                do {
                    try fileManager.removeItem(at: staged)
                } catch {
                    throw CaptureReceiptError.cleanupFailed
                }
            }
            return receipt.payload
        }
        guard stagedState.isValid else {
            if finalState.isMissing, stagedState.isMissing {
                throw CaptureReceiptError.missingScreenshot
            }
            throw CaptureReceiptError.screenshotMismatch
        }

        if fileManager.fileExists(atPath: final.path) {
            do {
                try fileManager.removeItem(at: final)
            } catch {
                throw CaptureReceiptError.cleanupFailed
            }
        }
        do {
            try fileManager.moveItem(at: staged, to: final)
        } catch {
            throw CaptureReceiptError.cleanupFailed
        }
        return receipt.payload
    }

    public static func removeReceipt(assetRoot: URL, captureId: String) throws {
        try validateCaptureId(captureId)
        _ = try validatedDirectory(assetRoot: assetRoot, captureId: captureId)
        try FileManager.default.removeItem(at: receiptURL(assetRoot: assetRoot, captureId: captureId))
    }

    /// Completes helper ownership transfer after main durably accepts a result.
    /// The final asset is intentionally preserved for the main-process outbox;
    /// without a receipt it is no longer eligible for helper replay.
    @discardableResult
    public static func acknowledge(assetRoot: URL, captureId: String) throws -> Bool {
        try validateCaptureId(captureId)
        let receipt = receiptURL(assetRoot: assetRoot, captureId: captureId)
        guard FileManager.default.fileExists(atPath: receipt.path) else {
            return false
        }
        try removeReceipt(assetRoot: assetRoot, captureId: captureId)
        return true
    }

    public static func removeCapture(assetRoot: URL, captureId: String) throws {
        _ = try read(assetRoot: assetRoot, captureId: captureId)
        try FileManager.default.removeItem(
            at: CaptureAsset.captureDirectoryURL(assetRoot: assetRoot, captureId: captureId)
        )
    }

    /// Discards a helper-owned durable artifact after a terminal main-process
    /// rejection. Unknown ids are intentionally idempotent no-ops.
    @discardableResult
    public static func reject(assetRoot: URL, captureId: String) throws -> Bool {
        try validateCaptureId(captureId)
        let receipt = receiptURL(assetRoot: assetRoot, captureId: captureId)
        guard FileManager.default.fileExists(atPath: receipt.path) else {
            return false
        }
        try removeCapture(assetRoot: assetRoot, captureId: captureId)
        return true
    }

    public static func discard(
        _ receipt: CaptureReceipt,
        assetRoot: URL
    ) throws {
        let stored = try read(assetRoot: assetRoot, captureId: receipt.captureId)
        guard stored == receipt else {
            throw CaptureReceiptError.invalidReceipt
        }
        try FileManager.default.removeItem(
            at: CaptureAsset.captureDirectoryURL(assetRoot: assetRoot, captureId: receipt.captureId)
        )
    }

    public static func disposition(
        for receipt: CaptureReceipt,
        workspaceId: String,
        deviceId: String,
        policy: CapturePolicyIdentity
    ) -> CaptureReceiptDisposition {
        guard receipt.workspaceId == workspaceId, receipt.deviceId == deviceId else {
            return .discardOwnerMismatch
        }
        guard receipt.policy == policy else {
            return .discardPolicyMismatch
        }
        return .replay
    }

    public static func listArtifacts(assetRoot: URL) throws -> [CaptureArtifact] {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: assetRoot.path, isDirectory: &isDirectory) else {
            return []
        }
        guard isDirectory.boolValue else {
            throw CaptureReceiptError.invalidReceipt
        }
        let rootValues = try assetRoot.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard rootValues.isDirectory == true, rootValues.isSymbolicLink != true else {
            throw CaptureReceiptError.invalidReceipt
        }
        let entries = try FileManager.default.contentsOfDirectory(
            at: assetRoot,
            includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
            options: [.skipsHiddenFiles]
        )

        var artifacts: [CaptureArtifact] = []
        for entry in entries {
            let values = try entry.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard values.isDirectory == true else {
                continue
            }
            guard values.isSymbolicLink != true else {
                throw CaptureReceiptError.invalidReceipt
            }
            let hasReceipt = FileManager.default.fileExists(
                atPath: entry.appendingPathComponent(receiptFileName).path
            )
            guard CaptureAsset.isSafeCaptureId(entry.lastPathComponent) else {
                if hasReceipt {
                    throw CaptureReceiptError.invalidCaptureId
                }
                continue
            }
            let kind: CaptureArtifactKind
            if hasReceipt {
                kind = .receipt
            } else if FileManager.default.fileExists(
                atPath: entry.appendingPathComponent(CaptureAsset.screenshotFileName).path
            ) {
                kind = .accepted
            } else {
                kind = .orphan
            }
            artifacts.append(CaptureArtifact(captureId: entry.lastPathComponent, kind: kind))
        }
        return artifacts.sorted { $0.captureId < $1.captureId }
    }

    public static func removeOrphan(assetRoot: URL, captureId: String) throws {
        try validateCaptureId(captureId)
        let directory = try validatedDirectory(assetRoot: assetRoot, captureId: captureId)
        let receipt = directory.appendingPathComponent(receiptFileName, isDirectory: false)
        guard !FileManager.default.fileExists(atPath: receipt.path) else {
            throw CaptureReceiptError.invalidReceipt
        }

        let entries = try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.isSymbolicLinkKey, .isDirectoryKey],
            options: []
        )
        let ownedNames = Set([stagedScreenshotFileName, CaptureAsset.screenshotFileName])
        for entry in entries {
            let values = try entry.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey])
            guard values.isSymbolicLink != true,
                  values.isDirectory != true,
                  ownedNames.contains(entry.lastPathComponent)
            else {
                throw CaptureReceiptError.invalidReceipt
            }
        }
        try FileManager.default.removeItem(at: directory)
    }

    private enum ScreenshotState {
        case missing
        case unreadable
        case invalid
        case valid

        var isMissing: Bool {
            if case .missing = self { return true }
            return false
        }

        var isUnreadable: Bool {
            if case .unreadable = self { return true }
            return false
        }

        var isValid: Bool {
            if case .valid = self { return true }
            return false
        }
    }

    private static func inspect(
        _ url: URL,
        receipt: CaptureReceipt,
        expectedPolicy: CapturePolicyIdentity?
    ) -> ScreenshotState {
        guard FileManager.default.fileExists(atPath: url.path) else { return .missing }
        guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
              values.isRegularFile == true,
              values.isSymbolicLink != true
        else {
            return .unreadable
        }
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            return .unreadable
        }
        do {
            try CaptureArtifactValidator.validate(
                receipt,
                captureId: receipt.captureId,
                expectedPolicy: expectedPolicy,
                imageData: data
            )
            return .valid
        } catch {
            return .invalid
        }
    }

    private static func validatedDirectory(assetRoot: URL, captureId: String) throws -> URL {
        try validateCaptureId(captureId)
        let directory = CaptureAsset.captureDirectoryURL(assetRoot: assetRoot, captureId: captureId)
        let values = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink != true else {
            throw CaptureReceiptError.invalidReceipt
        }
        return directory
    }

    private static func validateCaptureId(_ captureId: String) throws {
        guard CaptureAsset.isSafeCaptureId(captureId) else {
            throw CaptureReceiptError.invalidCaptureId
        }
    }
}
