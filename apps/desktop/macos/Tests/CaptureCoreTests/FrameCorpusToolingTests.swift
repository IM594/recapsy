import Foundation
import FrameCorpusTooling
import XCTest

final class FrameCorpusToolingTests: XCTestCase {
    func testFixtureSpecificationsProvideTwoFictionalSamplesPerDecision() {
        let specifications = FrameCorpusFixtureSpecification.all

        XCTAssertEqual(specifications.filter { $0.expected == .lowInformation }.count, 2)
        XCTAssertEqual(specifications.filter { $0.expected == .accept }.count, 2)
        XCTAssertEqual(Set(specifications.map(\.file)).count, specifications.count)
        XCTAssertTrue(specifications.allSatisfy { $0.file.hasSuffix(".png") })
    }

    func testPendingManifestUsesHonestRendererProvenanceAndChecksums() throws {
        let manifest = try FrameCorpusManifestFactory.makePending(
            fixtures: fixtureInputs()
        )

        XCTAssertEqual(manifest.version, 1)
        XCTAssertEqual(manifest.provenance.kind, "real-pixel-screenshot")
        XCTAssertFalse(manifest.provenance.containsRealUserData)
        XCTAssertEqual(manifest.provenance.captureMethod, "appkit-content-view-cache-display")
        XCTAssertEqual(manifest.provenance.generator, "FrameCorpusCapture/1")
        XCTAssertEqual(manifest.provenance.sourceEnvironment, "purpose-built-test-window")
        XCTAssertEqual(manifest.provenance.privacyReview, "pending-manual-review")
        XCTAssertEqual(
            manifest.fixtures.map(\.sha256),
            fixtureInputs().map { FrameCorpusDigest.sha256($0.data) }
        )
    }

    func testPendingManifestRejectsIncompleteFixedFixtureSet() {
        let inputs = fixtureInputs()

        XCTAssertThrowsError(
            try FrameCorpusManifestFactory.makePending(
                fixtures: [inputs[0], inputs[2]]
            )
        ) { error in
            XCTAssertEqual(error as? FrameCorpusToolingError, .fixtureSpecificationMismatch)
        }
    }

    func testPendingManifestRequiresBothCalibrationDecisions() {
        XCTAssertThrowsError(
            try FrameCorpusManifestFactory.makePending(fixtures: [fixtureInputs()[0]])
        ) { error in
            XCTAssertEqual(error as? FrameCorpusToolingError, .missingDecisionCoverage)
        }
    }

    func testApprovalRequiresExplicitHumanConfirmation() throws {
        let pending = try FrameCorpusManifestFactory.makePending(fixtures: fixtureInputs())

        XCTAssertThrowsError(
            try FrameCorpusReview.approve(
                pending,
                fixtureData: fixtureData(),
                confirmedNoUserData: false
            )
        ) { error in
            XCTAssertEqual(error as? FrameCorpusToolingError, .reviewConfirmationRequired)
        }
    }

    func testApprovalRejectsPixelDriftAfterHumanReview() throws {
        let pending = try FrameCorpusManifestFactory.makePending(fixtures: fixtureInputs())
        var changed = fixtureData()
        changed["accepted-fictional-notes.png"] = Data("changed pixels".utf8)

        XCTAssertThrowsError(
            try FrameCorpusReview.approve(
                pending,
                fixtureData: changed,
                confirmedNoUserData: true
            )
        ) { error in
            XCTAssertEqual(
                error as? FrameCorpusToolingError,
                .checksumMismatch("accepted-fictional-notes.png")
            )
        }
    }

    func testManifestCodecRoundTripsThePendingAuditRecord() throws {
        let pending = try FrameCorpusManifestFactory.makePending(fixtures: fixtureInputs())

        XCTAssertEqual(
            try FrameCorpusManifestCodec.decode(FrameCorpusManifestCodec.encode(pending)),
            pending
        )
    }

    func testCaptureSourceCannotEnumerateOrReadOtherWindows() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("FixtureTools/FrameCorpusCapture/main.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)

        for forbidden in [
            "ScreenCaptureKit",
            "SCScreenshotManager",
            "SCShareableContent",
            "CGWindowList",
            "CGDisplayCreateImage",
            "NSWorkspace",
            "NSApplication.shared.windows",
        ] {
            XCTAssertFalse(source.contains(forbidden), forbidden)
        }
        XCTAssertTrue(source.contains("bitmapImageRepForCachingDisplay"))
        XCTAssertTrue(source.contains("cacheDisplay(in: view.bounds, to: representation)"))
    }

    func testApprovalChangesOnlyThePrivacyReviewState() throws {
        let pending = try FrameCorpusManifestFactory.makePending(fixtures: fixtureInputs())
        let approved = try FrameCorpusReview.approve(
            pending,
            fixtureData: fixtureData(),
            confirmedNoUserData: true
        )

        XCTAssertEqual(approved.provenance.privacyReview, "approved-no-user-data")
        XCTAssertEqual(approved.fixtures, pending.fixtures)
        XCTAssertEqual(approved.provenance.captureMethod, pending.provenance.captureMethod)
        XCTAssertEqual(approved.provenance.sourceEnvironment, pending.provenance.sourceEnvironment)
    }

    func testOutputGuardRejectsRepositoryAndDescendantPaths() {
        let repository = URL(fileURLWithPath: "/workspace/recapsy", isDirectory: true)

        for path in [repository, repository.appendingPathComponent("corpus", isDirectory: true)] {
            XCTAssertThrowsError(
                try FrameCorpusOutputGuard.requireOutsideRepository(
                    path,
                    repositoryDirectory: repository
                )
            ) { error in
                XCTAssertEqual(error as? FrameCorpusToolingError, .outputInsideRepository)
            }
        }
    }

    func testOutputGuardAcceptsExternalDirectory() throws {
        XCTAssertNoThrow(
            try FrameCorpusOutputGuard.requireOutsideRepository(
                URL(fileURLWithPath: "/external/frame-corpus", isDirectory: true),
                repositoryDirectory: URL(fileURLWithPath: "/workspace/recapsy", isDirectory: true)
            )
        )
    }

    func testAtomicCorpusWriterRefusesToOverwriteExistingArtifact() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "recapsy-frame-corpus-writer-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        let artifact = directory.appendingPathComponent("manifest.json")

        try FrameCorpusFileWriter.writeNew(Data("first".utf8), to: artifact)

        XCTAssertThrowsError(
            try FrameCorpusFileWriter.writeNew(Data("second".utf8), to: artifact)
        ) { error in
            XCTAssertEqual(
                error as? FrameCorpusToolingError,
                .destinationAlreadyExists("manifest.json")
            )
        }
        XCTAssertEqual(try Data(contentsOf: artifact), Data("first".utf8))
    }

    private func fixtureInputs() -> [FrameCorpusFixtureInput] {
        return FrameCorpusFixtureSpecification.all.map { specification in
            FrameCorpusFixtureInput(
                file: specification.file,
                data: renderedBytes(for: specification.file),
                pixelWidth: 480,
                pixelHeight: 270,
                expected: specification.expected,
                purpose: specification.purpose
            )
        }
    }

    private func fixtureData() -> [String: Data] {
        return Dictionary(
            uniqueKeysWithValues: fixtureInputs().map { ($0.file, $0.data) }
        )
    }

    private func renderedBytes(for file: String) -> Data {
        return Data("rendered pixels for \(file)".utf8)
    }
}
