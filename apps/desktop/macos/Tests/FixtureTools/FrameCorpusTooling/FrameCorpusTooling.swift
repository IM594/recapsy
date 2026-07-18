import CryptoKit
import Foundation

public enum FrameCorpusExpectedDecision: String, Codable, Equatable {
    case lowInformation = "low-information"
    case accept
}

public struct FrameCorpusWindowIdentityCandidate: Equatable {
    public let windowID: UInt32
    public let ownerProcessID: Int32
    public let isOnScreen: Bool

    public init(windowID: UInt32, ownerProcessID: Int32, isOnScreen: Bool) {
        self.windowID = windowID
        self.ownerProcessID = ownerProcessID
        self.isOnScreen = isOnScreen
    }
}

public enum FrameCorpusWindowIdentity {
    public static func selectUniqueOwnedWindowID(
        candidates: [FrameCorpusWindowIdentityCandidate],
        targetWindowID: UInt32,
        processID: Int32
    ) -> UInt32? {
        let matches = candidates.filter { candidate in
            candidate.windowID == targetWindowID &&
                candidate.ownerProcessID == processID &&
                candidate.isOnScreen
        }
        guard matches.count == 1 else {
            return nil
        }
        return matches[0].windowID
    }
}

public enum FrameCorpusScene: String, Equatable {
    case horizontalGradient
    case verticalGradient
    case fictionalNotes
    case fictionalTasks
}

public struct FrameCorpusFixtureSpecification: Equatable {
    public let file: String
    public let expected: FrameCorpusExpectedDecision
    public let purpose: String
    public let scene: FrameCorpusScene

    public init(
        file: String,
        expected: FrameCorpusExpectedDecision,
        purpose: String,
        scene: FrameCorpusScene
    ) {
        self.file = file
        self.expected = expected
        self.purpose = purpose
        self.scene = scene
    }

    public static let all: [FrameCorpusFixtureSpecification] = [
        FrameCorpusFixtureSpecification(
            file: "low-information-horizontal-gradient.png",
            expected: .lowInformation,
            purpose: "ScreenCaptureKit capture of a smooth horizontal surface",
            scene: .horizontalGradient
        ),
        FrameCorpusFixtureSpecification(
            file: "low-information-vertical-gradient.png",
            expected: .lowInformation,
            purpose: "ScreenCaptureKit capture of a smooth vertical surface",
            scene: .verticalGradient
        ),
        FrameCorpusFixtureSpecification(
            file: "accepted-fictional-notes.png",
            expected: .accept,
            purpose: "ScreenCaptureKit capture of fictional note content",
            scene: .fictionalNotes
        ),
        FrameCorpusFixtureSpecification(
            file: "accepted-fictional-tasks.png",
            expected: .accept,
            purpose: "ScreenCaptureKit capture of fictional task content",
            scene: .fictionalTasks
        ),
    ]
}

public struct FrameCorpusFixtureInput {
    public let file: String
    public let data: Data
    public let pixelWidth: Int
    public let pixelHeight: Int
    public let expected: FrameCorpusExpectedDecision
    public let purpose: String

    public init(
        file: String,
        data: Data,
        pixelWidth: Int,
        pixelHeight: Int,
        expected: FrameCorpusExpectedDecision,
        purpose: String
    ) {
        self.file = file
        self.data = data
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
        self.expected = expected
        self.purpose = purpose
    }
}

public struct FrameCorpusManifest: Codable, Equatable {
    public struct Provenance: Codable, Equatable {
        public let kind: String
        public let containsRealUserData: Bool
        public let captureMethod: String
        public let generator: String
        public let sourceEnvironment: String
        public let privacyReview: String

        public init(
            kind: String,
            containsRealUserData: Bool,
            captureMethod: String,
            generator: String,
            sourceEnvironment: String,
            privacyReview: String
        ) {
            self.kind = kind
            self.containsRealUserData = containsRealUserData
            self.captureMethod = captureMethod
            self.generator = generator
            self.sourceEnvironment = sourceEnvironment
            self.privacyReview = privacyReview
        }
    }

    public struct Fixture: Codable, Equatable {
        public let file: String
        public let sha256: String
        public let expected: FrameCorpusExpectedDecision
        public let purpose: String
        public let pixelWidth: Int
        public let pixelHeight: Int

        public init(
            file: String,
            sha256: String,
            expected: FrameCorpusExpectedDecision,
            purpose: String,
            pixelWidth: Int,
            pixelHeight: Int
        ) {
            self.file = file
            self.sha256 = sha256
            self.expected = expected
            self.purpose = purpose
            self.pixelWidth = pixelWidth
            self.pixelHeight = pixelHeight
        }
    }

    public let version: Int
    public let provenance: Provenance
    public let fixtures: [Fixture]

    public init(version: Int, provenance: Provenance, fixtures: [Fixture]) {
        self.version = version
        self.provenance = provenance
        self.fixtures = fixtures
    }
}

public enum FrameCorpusToolingError: Error, Equatable {
    case checksumMismatch(String)
    case destinationAlreadyExists(String)
    case duplicateFixtureFile(String)
    case duplicateFixturePixels
    case emptyFixtureData(String)
    case invalidFixtureFile(String)
    case invalidPixelDimensions(String)
    case invalidProvenance
    case invalidReviewState
    case fixtureSpecificationMismatch
    case missingDecisionCoverage
    case outputInsideRepository
    case reviewConfirmationRequired
    case unexpectedFixtureData
}

public enum FrameCorpusDigest {
    public static func sha256(_ data: Data) -> String {
        return SHA256.hash(data: data)
            .map { String(format: "%02x", $0) }
            .joined()
    }
}

public enum FrameCorpusManifestFactory {
    public static func makePending(
        fixtures: [FrameCorpusFixtureInput]
    ) throws -> FrameCorpusManifest {
        let decisions = Set(fixtures.map(\.expected))
        guard decisions.contains(.lowInformation), decisions.contains(.accept) else {
            throw FrameCorpusToolingError.missingDecisionCoverage
        }
        guard fixtureSpecificationsMatch(fixtures) else {
            throw FrameCorpusToolingError.fixtureSpecificationMismatch
        }

        var seenFiles = Set<String>()
        let manifestFixtures = try fixtures.map { fixture in
            guard FrameCorpusPath.isSafeFixtureFile(fixture.file) else {
                throw FrameCorpusToolingError.invalidFixtureFile(fixture.file)
            }
            guard seenFiles.insert(fixture.file).inserted else {
                throw FrameCorpusToolingError.duplicateFixtureFile(fixture.file)
            }
            guard !fixture.data.isEmpty else {
                throw FrameCorpusToolingError.emptyFixtureData(fixture.file)
            }
            guard fixture.pixelWidth > 0, fixture.pixelHeight > 0 else {
                throw FrameCorpusToolingError.invalidPixelDimensions(fixture.file)
            }
            return FrameCorpusManifest.Fixture(
                file: fixture.file,
                sha256: FrameCorpusDigest.sha256(fixture.data),
                expected: fixture.expected,
                purpose: fixture.purpose,
                pixelWidth: fixture.pixelWidth,
                pixelHeight: fixture.pixelHeight
            )
        }
        guard Set(manifestFixtures.map(\.sha256)).count == manifestFixtures.count else {
            throw FrameCorpusToolingError.duplicateFixturePixels
        }

        return FrameCorpusManifest(
            version: 1,
            provenance: FrameCorpusManifest.Provenance(
                kind: "real-pixel-screenshot",
                containsRealUserData: false,
                captureMethod: "screen-capture-kit-desktop-independent-window",
                generator: "FrameCorpusCapture/2",
                sourceEnvironment: "purpose-built-test-window-via-windowserver",
                privacyReview: "pending-manual-review"
            ),
            fixtures: manifestFixtures
        )
    }

    private static func fixtureSpecificationsMatch(
        _ fixtures: [FrameCorpusFixtureInput]
    ) -> Bool {
        guard fixtures.count == FrameCorpusFixtureSpecification.all.count else {
            return false
        }
        return FrameCorpusFixtureSpecification.all.allSatisfy { specification in
            let matches = fixtures.filter { $0.file == specification.file }
            return matches.count == 1 &&
                matches[0].expected == specification.expected &&
                matches[0].purpose == specification.purpose
        }
    }
}

public enum FrameCorpusReview {
    public static func approve(
        _ manifest: FrameCorpusManifest,
        fixtureData: [String: Data],
        confirmedNoUserData: Bool
    ) throws -> FrameCorpusManifest {
        guard confirmedNoUserData else {
            throw FrameCorpusToolingError.reviewConfirmationRequired
        }
        guard manifest.version == 1,
              manifest.provenance.kind == "real-pixel-screenshot",
              !manifest.provenance.containsRealUserData,
              manifest.provenance.captureMethod ==
              "screen-capture-kit-desktop-independent-window",
              manifest.provenance.generator == "FrameCorpusCapture/2",
              manifest.provenance.sourceEnvironment ==
              "purpose-built-test-window-via-windowserver"
        else {
            throw FrameCorpusToolingError.invalidProvenance
        }
        guard manifest.provenance.privacyReview == "pending-manual-review" else {
            throw FrameCorpusToolingError.invalidReviewState
        }

        let expectedFiles = Set(manifest.fixtures.map(\.file))
        guard expectedFiles == Set(fixtureData.keys) else {
            throw FrameCorpusToolingError.unexpectedFixtureData
        }
        guard manifest.fixtures.count == FrameCorpusFixtureSpecification.all.count,
              expectedFiles == Set(FrameCorpusFixtureSpecification.all.map(\.file)),
              Set(manifest.fixtures.map(\.sha256)).count == manifest.fixtures.count
        else {
            throw FrameCorpusToolingError.fixtureSpecificationMismatch
        }
        let specificationByFile = Dictionary(
            uniqueKeysWithValues: FrameCorpusFixtureSpecification.all.map { ($0.file, $0) }
        )
        for fixture in manifest.fixtures {
            guard FrameCorpusPath.isSafeFixtureFile(fixture.file) else {
                throw FrameCorpusToolingError.invalidFixtureFile(fixture.file)
            }
            guard let specification = specificationByFile[fixture.file],
                  specification.expected == fixture.expected,
                  specification.purpose == fixture.purpose
            else {
                throw FrameCorpusToolingError.fixtureSpecificationMismatch
            }
            guard let data = fixtureData[fixture.file],
                  FrameCorpusDigest.sha256(data) == fixture.sha256
            else {
                throw FrameCorpusToolingError.checksumMismatch(fixture.file)
            }
        }

        return FrameCorpusManifest(
            version: manifest.version,
            provenance: FrameCorpusManifest.Provenance(
                kind: manifest.provenance.kind,
                containsRealUserData: manifest.provenance.containsRealUserData,
                captureMethod: manifest.provenance.captureMethod,
                generator: manifest.provenance.generator,
                sourceEnvironment: manifest.provenance.sourceEnvironment,
                privacyReview: "approved-no-user-data"
            ),
            fixtures: manifest.fixtures
        )
    }

}

public enum FrameCorpusManifestCodec {
    public static func encode(_ manifest: FrameCorpusManifest) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(manifest)
    }

    public static func decode(_ data: Data) throws -> FrameCorpusManifest {
        return try JSONDecoder().decode(FrameCorpusManifest.self, from: data)
    }
}

public enum FrameCorpusPath {
    public static func isSafeFixtureFile(_ file: String) -> Bool {
        return !file.isEmpty &&
            file.hasSuffix(".png") &&
            URL(fileURLWithPath: file).lastPathComponent == file
    }
}

public enum FrameCorpusOutputGuard {
    public static func requireOutsideRepository(
        _ outputDirectory: URL,
        repositoryDirectory: URL
    ) throws {
        let output = outputDirectory.standardizedFileURL.resolvingSymlinksInPath()
        let repository = repositoryDirectory.standardizedFileURL.resolvingSymlinksInPath()
        guard output != repository,
              !output.path.hasPrefix(repository.path + "/")
        else {
            throw FrameCorpusToolingError.outputInsideRepository
        }
    }
}

public enum FrameCorpusFileWriter {
    public static func writeNew(
        _ data: Data,
        to url: URL,
        fileManager: FileManager = .default
    ) throws {
        guard !fileManager.fileExists(atPath: url.path) else {
            throw FrameCorpusToolingError.destinationAlreadyExists(url.lastPathComponent)
        }
        try data.write(to: url, options: .atomic)
    }
}
