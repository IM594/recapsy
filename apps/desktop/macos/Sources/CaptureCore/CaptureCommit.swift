import Foundation

public enum CaptureCommitOutcome {
    case committed(CaptureResultPayload, URL)
    case skipped(CaptureCoverageState)
}

/// Immutable identity for one active capture session. Reconfiguring, pausing,
/// or stopping capture creates or removes the identity instead of advancing a
/// shared generation counter.
public struct CaptureSessionIdentity: Equatable {
    public let id: UUID
    public let policy: CapturePolicyIdentity

    public init(policy: CapturePolicyIdentity) {
        self.id = UUID()
        self.policy = policy
    }
}

/// Final persistence boundary for one encoded capture. Work can enter durable
/// storage only while its exact capture session remains active.
public enum CaptureCommitCoordinator {
    public static func finalize(
        startedSession: CaptureSessionIdentity,
        currentSession: CaptureSessionIdentity?,
        receipt: CaptureReceipt,
        imageData: Data,
        assetRoot: URL,
        captureId: String
    ) throws -> CaptureCommitOutcome {
        guard
            currentSession == startedSession,
            receipt.policy == startedSession.policy
        else {
            return .skipped(.privacyWithheld)
        }
        try CaptureArtifactValidator.validate(
            receipt,
            captureId: captureId,
            expectedPolicy: startedSession.policy,
            imageData: imageData
        )

        let directory = CaptureAsset.captureDirectoryURL(assetRoot: assetRoot, captureId: captureId)
        let staged = CaptureArtifactStore.stagedScreenshotFileURL(
            assetRoot: assetRoot,
            captureId: captureId
        )
        let final = CaptureAsset.screenshotFileURL(assetRoot: assetRoot, captureId: captureId)

        var createdDirectory = false
        do {
            try FileManager.default.createDirectory(
                at: assetRoot,
                withIntermediateDirectories: true
            )
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: false
            )
            createdDirectory = true
            try imageData.write(to: staged, options: .atomic)
            try CaptureArtifactStore.write(receipt, assetRoot: assetRoot, captureId: captureId)
            try FileManager.default.moveItem(at: staged, to: final)
        } catch {
            if createdDirectory {
                do {
                    try FileManager.default.removeItem(at: directory)
                } catch {
                    throw CaptureReceiptError.cleanupFailed
                }
            }
            throw error
        }

        return .committed(receipt.payload, directory)
    }
}
