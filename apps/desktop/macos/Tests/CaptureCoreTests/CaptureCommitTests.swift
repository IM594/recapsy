import Foundation
import XCTest
@testable import CaptureCore

final class CaptureCommitCoordinatorTests: XCTestCase {
    private let oldPolicyHash = "sha256:" + String(repeating: "a", count: 64)
    private let newPolicyHash = "sha256:" + String(repeating: "b", count: 64)

    func testCaptureStartedBeforePolicyChangeIsDiscardedWhenItFinishesAfterActivation() throws {
        let root = uniqueRoot("stale")
        defer { try? FileManager.default.removeItem(at: root) }
        let captureId = "cap-old-generation"
        let image = Data("old-generation-screen".utf8)
        let receipt = makeReceipt(image: image, captureId: captureId, policyVersion: "policy-old")

        let siblingDirectory = CaptureAsset.captureDirectoryURL(
            assetRoot: root,
            captureId: "cap-unrelated"
        )
        let siblingAsset = siblingDirectory.appendingPathComponent("screenshot.webp")
        try FileManager.default.createDirectory(at: siblingDirectory, withIntermediateDirectories: true)
        try Data("unrelated".utf8).write(to: siblingAsset, options: .atomic)

        let outcome = try CaptureCommitCoordinator.finalize(
            startedPolicyHash: oldPolicyHash,
            currentPolicyHash: newPolicyHash,
            receipt: receipt,
            imageData: image,
            assetRoot: root,
            captureId: captureId
        )

        guard case let .skipped(reason) = outcome else {
            return XCTFail("A stale capture must not produce a committed result.")
        }
        XCTAssertEqual(reason.rawValue, "policy_denied")
        XCTAssertFalse(FileManager.default.fileExists(atPath: captureDirectory(root, captureId).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: receiptURL(root, captureId).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: stagedURL(root, captureId).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: finalURL(root, captureId).path))
        XCTAssertEqual(try Data(contentsOf: siblingAsset), Data("unrelated".utf8))
    }

    func testStaleCleanupDoesNotDeleteNewGenerationArtifactsWithTheSameCaptureId() throws {
        let root = uniqueRoot("shared-id")
        defer { try? FileManager.default.removeItem(at: root) }
        let captureId = "cap-shared-id"
        let oldImage = Data("old-generation-screen".utf8)
        let oldReceipt = makeReceipt(
            image: oldImage,
            captureId: captureId,
            policyVersion: "policy-old"
        )
        let newImage = Data("new-generation-screen".utf8)
        let newReceipt = makeReceipt(
            image: newImage,
            captureId: captureId,
            policyVersion: "policy-new"
        )
        try FileManager.default.createDirectory(
            at: captureDirectory(root, captureId),
            withIntermediateDirectories: true
        )
        try newImage.write(to: finalURL(root, captureId), options: .atomic)
        try CaptureReceiptStore.write(newReceipt, assetRoot: root, captureId: captureId)

        let outcome = try CaptureCommitCoordinator.finalize(
            startedPolicyHash: oldPolicyHash,
            currentPolicyHash: newPolicyHash,
            receipt: oldReceipt,
            imageData: oldImage,
            assetRoot: root,
            captureId: captureId
        )

        guard case .skipped = outcome else {
            return XCTFail("The old generation must be skipped.")
        }
        XCTAssertEqual(try Data(contentsOf: finalURL(root, captureId)), newImage)
        XCTAssertEqual(
            try CaptureReceiptStore.read(assetRoot: root, captureId: captureId).payload.context.policy.version,
            "policy-new"
        )
    }

    func testCaptureFromCurrentPolicyGenerationCommitsReceiptAssetAndResult() throws {
        let root = uniqueRoot("current")
        defer { try? FileManager.default.removeItem(at: root) }
        let captureId = "cap-current-generation"
        let image = Data("current-generation-screen".utf8)
        let receipt = makeReceipt(
            image: image,
            captureId: captureId,
            policyVersion: "policy-current"
        )

        let outcome = try CaptureCommitCoordinator.finalize(
            startedPolicyHash: newPolicyHash,
            currentPolicyHash: newPolicyHash,
            receipt: receipt,
            imageData: image,
            assetRoot: root,
            captureId: captureId
        )

        guard case let .committed(payload, directory) = outcome else {
            return XCTFail("The current policy generation must commit normally.")
        }
        XCTAssertEqual(payload.captureId, captureId)
        XCTAssertEqual(directory, captureDirectory(root, captureId))
        XCTAssertEqual(try Data(contentsOf: finalURL(root, captureId)), image)
        XCTAssertTrue(FileManager.default.fileExists(atPath: receiptURL(root, captureId).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: stagedURL(root, captureId).path))
    }

    func testPausedPolicyGenerationDiscardsInFlightCaptureEvenWhenHashIsUnchanged() throws {
        let root = uniqueRoot("paused-generation")
        defer { try? FileManager.default.removeItem(at: root) }
        let captureId = "cap-paused-generation"
        let image = Data("paused-generation-screen".utf8)
        let receipt = makeReceipt(
            image: image,
            captureId: captureId,
            policyVersion: "policy-current"
        )

        let outcome = try CaptureCommitCoordinator.finalize(
            startedPolicyHash: newPolicyHash,
            currentPolicyHash: newPolicyHash,
            startedPolicyGeneration: 7,
            currentPolicyGeneration: 8,
            receipt: receipt,
            imageData: image,
            assetRoot: root,
            captureId: captureId
        )

        guard case let .skipped(reason) = outcome else {
            return XCTFail("A capture crossing a pause generation must be skipped.")
        }
        XCTAssertEqual(reason.rawValue, "policy_denied")
        XCTAssertFalse(FileManager.default.fileExists(atPath: captureDirectory(root, captureId).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: receiptURL(root, captureId).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: stagedURL(root, captureId).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: finalURL(root, captureId).path))
    }

    func testCommitFailureCleansPreparedCaptureWithoutDeletingSiblingCapture() throws {
        let root = uniqueRoot("failure")
        defer { try? FileManager.default.removeItem(at: root) }
        let captureId = "cap-failed-commit"
        let image = Data("failed-commit-screen".utf8)
        let receipt = makeReceipt(image: image, captureId: captureId, policyVersion: "policy-current")
        try FileManager.default.createDirectory(
            at: receiptURL(root, captureId),
            withIntermediateDirectories: true
        )
        let siblingDirectory = captureDirectory(root, "cap-sibling")
        let siblingAsset = siblingDirectory.appendingPathComponent("screenshot.webp")
        try FileManager.default.createDirectory(at: siblingDirectory, withIntermediateDirectories: true)
        try Data("sibling".utf8).write(to: siblingAsset, options: .atomic)

        XCTAssertThrowsError(
            try CaptureCommitCoordinator.finalize(
                startedPolicyHash: newPolicyHash,
                currentPolicyHash: newPolicyHash,
                receipt: receipt,
                imageData: image,
                assetRoot: root,
                captureId: captureId
            )
        )
        XCTAssertFalse(FileManager.default.fileExists(atPath: captureDirectory(root, captureId).path))
        XCTAssertEqual(try Data(contentsOf: siblingAsset), Data("sibling".utf8))
    }

    private func makeReceipt(
        image: Data,
        captureId: String,
        policyVersion: String
    ) -> CaptureReceipt {
        let hash = CaptureAsset.contentHash(for: image)
        return CaptureReceipt(
            workspaceId: "workspace-1",
            deviceId: "device-1",
            payload: CaptureResultPayload(
                captureId: captureId,
                observedAt: "2026-07-18T00:00:00.000Z",
                manifest: CaptureAssetPayload(
                    role: "manifest",
                    ref: "\(captureId)/manifest.json",
                    hash: hash,
                    mimeType: "application/json",
                    sizeBytes: 0
                ),
                assets: [CaptureAssetPayload(
                    role: "screenshot",
                    ref: CaptureAsset.screenshotRelativeKey(captureId: captureId),
                    hash: hash,
                    mimeType: CaptureAsset.screenshotMimeType,
                    sizeBytes: image.count
                )],
                context: CaptureContextPayload(
                    observedAt: "2026-07-18T00:00:00.000Z",
                    policy: CapturePolicyPayload(version: policyVersion, decision: "allow")
                )
            ),
            screenshotHash: hash,
            screenshotSizeBytes: image.count
        )
    }

    private func uniqueRoot(_ suffix: String) -> URL {
        return FileManager.default.temporaryDirectory.appendingPathComponent(
            "recapsy-commit-\(suffix)-\(UUID().uuidString)",
            isDirectory: true
        )
    }

    private func captureDirectory(_ root: URL, _ captureId: String) -> URL {
        return CaptureAsset.captureDirectoryURL(assetRoot: root, captureId: captureId)
    }

    private func receiptURL(_ root: URL, _ captureId: String) -> URL {
        return CaptureReceiptStore.receiptURL(assetRoot: root, captureId: captureId)
    }

    private func stagedURL(_ root: URL, _ captureId: String) -> URL {
        return CaptureReceiptStore.stagedScreenshotFileURL(assetRoot: root, captureId: captureId)
    }

    private func finalURL(_ root: URL, _ captureId: String) -> URL {
        return CaptureAsset.screenshotFileURL(assetRoot: root, captureId: captureId)
    }
}
