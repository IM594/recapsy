import Foundation

public enum CaptureCommitOutcome {
    case committed(CaptureResultPayload, URL)
    case skipped(CaptureSkippedReason)
}

/// Final persistence boundary for one encoded capture. A policy generation is
/// rechecked before the durable receipt or final asset is created, so work that
/// started under an older policy can never enter the main-process outbox.
public enum CaptureCommitCoordinator {
    public static func finalize(
        startedPolicyHash: String,
        currentPolicyHash: String?,
        startedPolicyGeneration: UInt64 = 0,
        currentPolicyGeneration: UInt64 = 0,
        receipt: CaptureReceipt,
        imageData: Data,
        assetRoot: URL,
        captureId: String
    ) throws -> CaptureCommitOutcome {
        guard receipt.payload.captureId == captureId else {
            throw CaptureReceiptError.invalidReceipt
        }

        guard
            currentPolicyHash == startedPolicyHash,
            currentPolicyGeneration == startedPolicyGeneration
        else {
            return .skipped(.policyDenied)
        }
        guard
            imageData.count == receipt.screenshotSizeBytes,
            CaptureAsset.contentHash(for: imageData) == receipt.screenshotHash
        else {
            throw CaptureReceiptError.screenshotMismatch
        }

        let directory = CaptureAsset.captureDirectoryURL(assetRoot: assetRoot, captureId: captureId)
        let staged = CaptureReceiptStore.stagedScreenshotFileURL(
            assetRoot: assetRoot,
            captureId: captureId
        )
        let final = CaptureAsset.screenshotFileURL(assetRoot: assetRoot, captureId: captureId)

        do {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true
            )
            try imageData.write(to: staged, options: .atomic)
            try CaptureReceiptStore.write(receipt, assetRoot: assetRoot, captureId: captureId)
            try FileManager.default.moveItem(at: staged, to: final)
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }

        return .committed(receipt.payload, directory)
    }
}
