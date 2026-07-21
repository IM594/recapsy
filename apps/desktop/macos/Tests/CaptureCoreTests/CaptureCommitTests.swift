import Foundation
import XCTest
@testable import CaptureCore

final class CaptureCommitCoordinatorTests: XCTestCase {
    private let oldPolicyHash = "sha256:" + String(repeating: "a", count: 64)
    private let newPolicyHash = "sha256:" + String(repeating: "b", count: 64)

    func testReceiptStoresCanonicalPolicySourceAndScreenshotFacts() throws {
        let root = uniqueRoot("canonical-receipt")
        defer { try? FileManager.default.removeItem(at: root) }
        let image = Data("canonical-screen".utf8)
        let receipt = makeReceipt(image: image, captureId: "cap-canonical", policyVersion: "policy-current")
        try FileManager.default.createDirectory(
            at: captureDirectory(root, receipt.captureId),
            withIntermediateDirectories: true
        )

        try CaptureArtifactStore.write(receipt, assetRoot: root, captureId: receipt.payload.captureId)

        let stored = try CaptureArtifactStore.read(
            assetRoot: root,
            captureId: receipt.payload.captureId
        )
        XCTAssertEqual(stored.policy.hash, newPolicyHash)
        XCTAssertEqual(stored.policy.version, "policy-current")
        XCTAssertEqual(stored.source.windowId, 42)
        XCTAssertEqual(stored.source.ownerProcessId, 4242)
        XCTAssertEqual(stored.screenshot.ref, CaptureAsset.screenshotRelativeKey(captureId: "cap-canonical"))
        XCTAssertEqual(stored.screenshot.hash, CaptureAsset.contentHash(for: image))
        XCTAssertEqual(stored.screenshot.sizeBytes, image.count)
    }

    func testRecoveryPromotesValidStagedCopyWhenFinalCopyIsCorrupt() throws {
        let root = uniqueRoot("staged-priority")
        defer { try? FileManager.default.removeItem(at: root) }
        let captureId = "cap-staged-priority"
        let image = Data("valid-staged-screen".utf8)
        let receipt = makeReceipt(image: image, captureId: captureId, policyVersion: "policy-current")
        let directory = captureDirectory(root, captureId)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("corrupt-final".utf8).write(to: finalURL(root, captureId), options: .atomic)
        try image.write(to: stagedURL(root, captureId), options: .atomic)
        try CaptureArtifactStore.write(receipt, assetRoot: root, captureId: captureId)

        _ = try CaptureArtifactStore.recover(
            receipt,
            assetRoot: root,
            expectedPolicy: CapturePolicyIdentity(hash: newPolicyHash, version: "policy-current")
        )

        XCTAssertEqual(try Data(contentsOf: finalURL(root, captureId)), image)
        XCTAssertFalse(FileManager.default.fileExists(atPath: stagedURL(root, captureId).path))
    }

    func testRecoveryKeepsValidFinalCopyWhenStagedCopyIsCorrupt() throws {
        let root = uniqueRoot("final-priority")
        defer { try? FileManager.default.removeItem(at: root) }
        let captureId = "cap-final-priority"
        let image = Data("valid-final-screen".utf8)
        let receipt = makeReceipt(image: image, captureId: captureId, policyVersion: "policy-current")
        let directory = captureDirectory(root, captureId)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try image.write(to: finalURL(root, captureId), options: .atomic)
        try Data("corrupt-staged".utf8).write(to: stagedURL(root, captureId), options: .atomic)
        try CaptureArtifactStore.write(receipt, assetRoot: root, captureId: captureId)

        _ = try CaptureArtifactStore.recover(
            receipt,
            assetRoot: root,
            expectedPolicy: CapturePolicyIdentity(hash: newPolicyHash, version: "policy-current")
        )

        XCTAssertEqual(try Data(contentsOf: finalURL(root, captureId)), image)
        XCTAssertFalse(FileManager.default.fileExists(atPath: stagedURL(root, captureId).path))
    }

    func testRecoveryRejectsReceiptFromAnOlderPolicy() throws {
        let root = uniqueRoot("old-policy")
        defer { try? FileManager.default.removeItem(at: root) }
        let captureId = "cap-old-policy"
        let image = Data("old-policy-screen".utf8)
        let receipt = makeReceipt(image: image, captureId: captureId, policyVersion: "policy-old", policyHash: oldPolicyHash)
        let directory = captureDirectory(root, captureId)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try image.write(to: finalURL(root, captureId), options: .atomic)
        try CaptureArtifactStore.write(receipt, assetRoot: root, captureId: captureId)

        XCTAssertThrowsError(
            try CaptureArtifactStore.recover(
                receipt,
                assetRoot: root,
                expectedPolicy: CapturePolicyIdentity(hash: newPolicyHash, version: "policy-current")
            )
        ) { error in
            XCTAssertEqual(error as? CaptureReceiptError, .policyMismatch)
        }
    }

    func testReceiptDispositionSeparatesOwnerAndPolicyMismatch() throws {
        let receipt = makeReceipt(image: Data("disposition".utf8), captureId: "cap-disposition", policyVersion: "policy-old", policyHash: oldPolicyHash)
        let currentPolicy = CapturePolicyIdentity(hash: newPolicyHash, version: "policy-current")

        XCTAssertEqual(
            CaptureArtifactStore.disposition(
                for: receipt,
                workspaceId: "other-workspace",
                deviceId: "device-1",
                policy: currentPolicy
            ),
            .discardOwnerMismatch
        )
        XCTAssertEqual(
            CaptureArtifactStore.disposition(
                for: receipt,
                workspaceId: "workspace-1",
                deviceId: "device-1",
                policy: currentPolicy
            ),
            .discardPolicyMismatch
        )
        XCTAssertEqual(
            CaptureArtifactStore.disposition(
                for: makeReceipt(image: Data("disposition".utf8), captureId: "cap-disposition", policyVersion: "policy-current"),
                workspaceId: "workspace-1",
                deviceId: "device-1",
                policy: currentPolicy
            ),
            .replay
        )
    }

    func testDiscardCannotDeleteAReplacementReceiptForTheSameCaptureId() throws {
        let root = uniqueRoot("replacement-receipt")
        defer { try? FileManager.default.removeItem(at: root) }
        let captureId = "cap-replacement"
        let oldReceipt = makeReceipt(
            image: Data("old".utf8),
            captureId: captureId,
            policyVersion: "policy-old",
            policyHash: oldPolicyHash
        )
        let replacementImage = Data("replacement".utf8)
        let replacementReceipt = makeReceipt(
            image: replacementImage,
            captureId: captureId,
            policyVersion: "policy-current"
        )
        try FileManager.default.createDirectory(
            at: captureDirectory(root, captureId),
            withIntermediateDirectories: true
        )
        try replacementImage.write(to: finalURL(root, captureId), options: .atomic)
        try CaptureArtifactStore.write(replacementReceipt, assetRoot: root, captureId: captureId)

        XCTAssertThrowsError(
            try CaptureArtifactStore.discard(oldReceipt, assetRoot: root)
        ) { error in
            XCTAssertEqual(error as? CaptureReceiptError, .invalidReceipt)
        }
        XCTAssertEqual(
            try CaptureArtifactStore.read(assetRoot: root, captureId: captureId),
            replacementReceipt
        )
        XCTAssertEqual(try Data(contentsOf: finalURL(root, captureId)), replacementImage)
    }

    func testArtifactAcknowledgementRemovesOnlyTheReplayReceipt() throws {
        let root = uniqueRoot("artifact-ack")
        defer { try? FileManager.default.removeItem(at: root) }
        let captureId = "cap-artifact-ack"
        let image = Data("accepted-screen".utf8)
        let receipt = makeReceipt(image: image, captureId: captureId, policyVersion: "policy-current")
        try FileManager.default.createDirectory(
            at: captureDirectory(root, captureId),
            withIntermediateDirectories: true
        )
        try image.write(to: finalURL(root, captureId), options: .atomic)
        try CaptureArtifactStore.write(receipt, assetRoot: root, captureId: captureId)

        XCTAssertTrue(try CaptureArtifactStore.acknowledge(assetRoot: root, captureId: captureId))
        XCTAssertFalse(FileManager.default.fileExists(atPath: receiptURL(root, captureId).path))
        XCTAssertEqual(try Data(contentsOf: finalURL(root, captureId)), image)
        XCTAssertFalse(try CaptureArtifactStore.acknowledge(assetRoot: root, captureId: captureId))
    }

    func testArtifactRejectionOnlyDeletesReceiptOwnedCapture() throws {
        let root = uniqueRoot("artifact-reject")
        defer { try? FileManager.default.removeItem(at: root) }
        let captureId = "cap-artifact-reject"
        let image = Data("rejected-screen".utf8)
        let receipt = makeReceipt(image: image, captureId: captureId, policyVersion: "policy-current")
        try FileManager.default.createDirectory(
            at: captureDirectory(root, captureId),
            withIntermediateDirectories: true
        )
        try image.write(to: finalURL(root, captureId), options: .atomic)

        XCTAssertFalse(try CaptureArtifactStore.reject(assetRoot: root, captureId: captureId))
        XCTAssertTrue(FileManager.default.fileExists(atPath: finalURL(root, captureId).path))

        try CaptureArtifactStore.write(receipt, assetRoot: root, captureId: captureId)
        XCTAssertTrue(try CaptureArtifactStore.reject(assetRoot: root, captureId: captureId))
        XCTAssertFalse(FileManager.default.fileExists(atPath: captureDirectory(root, captureId).path))
    }

    func testCommitAndRecoveryRejectTheSameMalformedArtifactRecord() throws {
        let root = uniqueRoot("shared-validator")
        defer { try? FileManager.default.removeItem(at: root) }
        let captureId = "cap-shared-validator"
        let image = Data("shared-validator-screen".utf8)
        let receipt = makeReceipt(
            image: image,
            captureId: captureId,
            policyVersion: "policy-current",
            screenshotRef: "another-capture/screenshot.webp"
        )
        let policy = CapturePolicyIdentity(hash: newPolicyHash, version: "policy-current")
        let session = CaptureSessionIdentity(policy: policy)

        XCTAssertThrowsError(
            try CaptureCommitCoordinator.finalize(
                startedSession: session,
                currentSession: session,
                receipt: receipt,
                imageData: image,
                assetRoot: root,
                captureId: captureId
            )
        ) { error in
            XCTAssertEqual(error as? CaptureReceiptError, .invalidReceipt)
        }
        XCTAssertThrowsError(
            try CaptureArtifactStore.recover(
                receipt,
                assetRoot: root,
                expectedPolicy: policy
            )
        ) { error in
            XCTAssertEqual(error as? CaptureReceiptError, .invalidReceipt)
        }
    }

    func testRecoveryPreservesUnreadableScreenshotEvidence() throws {
        let root = uniqueRoot("unreadable")
        defer { try? FileManager.default.removeItem(at: root) }
        let captureId = "cap-unreadable"
        let image = Data("unreadable-screen".utf8)
        let receipt = makeReceipt(image: image, captureId: captureId, policyVersion: "policy-current")
        let final = finalURL(root, captureId)
        try FileManager.default.createDirectory(at: final, withIntermediateDirectories: true)
        try CaptureArtifactStore.write(receipt, assetRoot: root, captureId: captureId)

        XCTAssertThrowsError(
            try CaptureArtifactStore.recover(
                receipt,
                assetRoot: root,
                expectedPolicy: receipt.policy
            )
        ) { error in
            XCTAssertEqual(error as? CaptureReceiptError, .unreadableScreenshot)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: final.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: receiptURL(root, captureId).path))
    }

    func testStoreRejectsUnsafeCaptureIdBeforeResolvingAPath() throws {
        let root = uniqueRoot("unsafe-id")
        defer { try? FileManager.default.removeItem(at: root) }
        let captureId = "../outside"
        let receipt = makeReceipt(
            image: Data("unsafe-id-screen".utf8),
            captureId: captureId,
            policyVersion: "policy-current"
        )

        XCTAssertThrowsError(
            try CaptureArtifactStore.write(receipt, assetRoot: root, captureId: captureId)
        ) { error in
            XCTAssertEqual(error as? CaptureReceiptError, .invalidCaptureId)
        }
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: root.deletingLastPathComponent().appendingPathComponent("outside").path
            )
        )
    }

    func testRemoveCaptureRequiresAValidOwnedReceipt() throws {
        let root = uniqueRoot("owned-cleanup")
        defer { try? FileManager.default.removeItem(at: root) }
        let captureId = "cap-unowned"
        let directory = captureDirectory(root, captureId)
        let evidence = directory.appendingPathComponent("evidence.bin")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("evidence".utf8).write(to: evidence, options: .atomic)

        XCTAssertThrowsError(
            try CaptureArtifactStore.removeCapture(assetRoot: root, captureId: captureId)
        )
        XCTAssertEqual(try Data(contentsOf: evidence), Data("evidence".utf8))
    }

    func testStoreRejectsSymlinkedCaptureDirectory() throws {
        let root = uniqueRoot("symlink-root")
        let target = uniqueRoot("symlink-target")
        defer {
            try? FileManager.default.removeItem(at: root)
            try? FileManager.default.removeItem(at: target)
        }
        let captureId = "cap-symlink"
        let image = Data("symlink-screen".utf8)
        let receipt = makeReceipt(image: image, captureId: captureId, policyVersion: "policy-current")
        let targetDirectory = captureDirectory(target, captureId)
        let linkDirectory = captureDirectory(root, captureId)
        try FileManager.default.createDirectory(at: targetDirectory, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: linkDirectory, withDestinationURL: targetDirectory)
        let receiptData = try JSONEncoder().encode(receipt)
        try receiptData.write(
            to: targetDirectory.appendingPathComponent(CaptureArtifactStore.receiptFileName),
            options: .atomic
        )

        XCTAssertThrowsError(
            try CaptureArtifactStore.read(assetRoot: root, captureId: captureId)
        ) { error in
            XCTAssertEqual(error as? CaptureReceiptError, .invalidReceipt)
        }
        XCTAssertThrowsError(
            try CaptureArtifactStore.removeCapture(assetRoot: root, captureId: captureId)
        )
        XCTAssertTrue(FileManager.default.fileExists(atPath: targetDirectory.path))
    }

    func testCaptureStartedBeforePolicyChangeIsDiscardedWhenItFinishesAfterActivation() throws {
        let root = uniqueRoot("stale")
        defer { try? FileManager.default.removeItem(at: root) }
        let captureId = "cap-old-generation"
        let image = Data("old-generation-screen".utf8)
        let receipt = makeReceipt(
            image: image,
            captureId: captureId,
            policyVersion: "policy-old",
            policyHash: oldPolicyHash
        )

        let siblingDirectory = CaptureAsset.captureDirectoryURL(
            assetRoot: root,
            captureId: "cap-unrelated"
        )
        let siblingAsset = siblingDirectory.appendingPathComponent("screenshot.webp")
        try FileManager.default.createDirectory(at: siblingDirectory, withIntermediateDirectories: true)
        try Data("unrelated".utf8).write(to: siblingAsset, options: .atomic)

        let outcome = try CaptureCommitCoordinator.finalize(
            startedSession: CaptureSessionIdentity(
                policy: CapturePolicyIdentity(hash: oldPolicyHash, version: "policy-old")
            ),
            currentSession: CaptureSessionIdentity(
                policy: CapturePolicyIdentity(hash: newPolicyHash, version: "policy-new")
            ),
            receipt: receipt,
            imageData: image,
            assetRoot: root,
            captureId: captureId
        )

        guard case let .skipped(state) = outcome else {
            return XCTFail("A stale capture must not produce a committed result.")
        }
        XCTAssertEqual(state.rawValue, "privacy_withheld")
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
            policyVersion: "policy-old",
            policyHash: oldPolicyHash
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
        try CaptureArtifactStore.write(newReceipt, assetRoot: root, captureId: captureId)

        let outcome = try CaptureCommitCoordinator.finalize(
            startedSession: CaptureSessionIdentity(
                policy: CapturePolicyIdentity(hash: oldPolicyHash, version: "policy-old")
            ),
            currentSession: CaptureSessionIdentity(
                policy: CapturePolicyIdentity(hash: newPolicyHash, version: "policy-new")
            ),
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
            try CaptureArtifactStore.read(assetRoot: root, captureId: captureId).payload.context.policy.version,
            "policy-new"
        )
    }

    func testCaptureFromCurrentSessionCommitsReceiptAssetAndResult() throws {
        let root = uniqueRoot("current")
        defer { try? FileManager.default.removeItem(at: root) }
        let captureId = "cap-current-generation"
        let image = Data("current-generation-screen".utf8)
        let receipt = makeReceipt(
            image: image,
            captureId: captureId,
            policyVersion: "policy-current"
        )
        let session = CaptureSessionIdentity(
            policy: CapturePolicyIdentity(hash: newPolicyHash, version: "policy-current")
        )

        let outcome = try CaptureCommitCoordinator.finalize(
            startedSession: session,
            currentSession: session,
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

    func testPausedSessionDiscardsInFlightCaptureEvenWhenPolicyIsUnchanged() throws {
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
            startedSession: CaptureSessionIdentity(
                policy: CapturePolicyIdentity(hash: newPolicyHash, version: "policy-current")
            ),
            currentSession: CaptureSessionIdentity(
                policy: CapturePolicyIdentity(hash: newPolicyHash, version: "policy-current")
            ),
            receipt: receipt,
            imageData: image,
            assetRoot: root,
            captureId: captureId
        )

        guard case let .skipped(state) = outcome else {
            return XCTFail("A capture crossing a paused session boundary must be skipped.")
        }
        XCTAssertEqual(state.rawValue, "privacy_withheld")
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
        let session = CaptureSessionIdentity(
            policy: CapturePolicyIdentity(hash: newPolicyHash, version: "policy-current")
        )

        XCTAssertThrowsError(
            try CaptureCommitCoordinator.finalize(
                startedSession: session,
                currentSession: session,
                receipt: receipt,
                imageData: image,
                assetRoot: root,
                captureId: captureId
            )
        )
        XCTAssertTrue(FileManager.default.fileExists(atPath: captureDirectory(root, captureId).path))
        XCTAssertEqual(try Data(contentsOf: siblingAsset), Data("sibling".utf8))
    }

    private func makeReceipt(
        image: Data,
        captureId: String,
        policyVersion: String,
        policyHash: String? = nil,
        screenshotRef: String? = nil
    ) -> CaptureReceipt {
        let hash = CaptureAsset.contentHash(for: image)
        return CaptureReceipt(
            workspaceId: "workspace-1",
            deviceId: "device-1",
            captureId: captureId,
            observedAt: "2026-07-18T00:00:00.000Z",
            capturedAt: "2026-07-18T00:00:00.100Z",
            policy: CapturePolicyIdentity(
                hash: policyHash ?? newPolicyHash,
                version: policyVersion
            ),
            source: CaptureWindowIdentity(
                application: CaptureApplicationPayload(name: "Fixture App", bundleId: "one.recapsy.fixture"),
                windowId: 42,
                ownerProcessId: 4242
            ),
            screenshot: CaptureScreenshotRecord(
                ref: screenshotRef ?? CaptureAsset.screenshotRelativeKey(captureId: captureId),
                hash: hash,
                mimeType: CaptureAsset.screenshotMimeType,
                sizeBytes: image.count
            ),
            frameQuality: CaptureFrameQuality(luminanceBucket: 8, marginal: false),
            decision: "allow"
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
        return CaptureArtifactStore.receiptURL(assetRoot: root, captureId: captureId)
    }

    private func stagedURL(_ root: URL, _ captureId: String) -> URL {
        return CaptureArtifactStore.stagedScreenshotFileURL(assetRoot: root, captureId: captureId)
    }

    private func finalURL(_ root: URL, _ captureId: String) -> URL {
        return CaptureAsset.screenshotFileURL(assetRoot: root, captureId: captureId)
    }
}
