import CaptureCore
import CryptoKit
import Foundation
import FrameCorpusTooling
import ImageIO
import XCTest

/// Calibration against reviewed WindowServer pixels captured through
/// ScreenCaptureKit from the purpose-built test window. Only the approved
/// manifest and pixels are bundled; pending-review artifacts remain external.
final class CaptureFrameEconomyRealPixelCalibrationTests: XCTestCase {
    private struct Manifest: Decodable {
        struct Provenance: Decodable {
            let kind: String
            let containsRealUserData: Bool
            let captureMethod: String
            let generator: String
            let sourceEnvironment: String
            let privacyReview: String
        }

        struct Fixture: Decodable {
            let file: String
            let sha256: String
            let expected: String
            let purpose: String
            let pixelWidth: Int
            let pixelHeight: Int
        }

        let version: Int
        let provenance: Provenance
        let fixtures: [Fixture]
    }

    private enum CalibrationError: Error {
        case undecodable(String)
        case samplingFailed(String)
    }

    private let context = CaptureFrameContext(
        bundleId: "one.recapsy.real-pixel-calibration",
        windowId: 101
    )

    func testBundledReviewedRealPixelCorpus() throws {
        let manifestURL = try XCTUnwrap(Bundle.module.url(
            forResource: "real-pixel-manifest",
            withExtension: "json"
        ))
        let directory = manifestURL.deletingLastPathComponent()
        let manifest = try JSONDecoder().decode(
            Manifest.self,
            from: Data(contentsOf: manifestURL)
        )

        XCTAssertEqual(manifest.version, 1)
        XCTAssertEqual(manifest.provenance.kind, "real-pixel-screenshot")
        XCTAssertFalse(manifest.provenance.containsRealUserData)
        XCTAssertEqual(
            manifest.provenance.captureMethod,
            "screen-capture-kit-desktop-independent-window"
        )
        XCTAssertEqual(manifest.provenance.generator, "FrameCorpusCapture/2")
        XCTAssertEqual(
            manifest.provenance.sourceEnvironment,
            "purpose-built-test-window-via-windowserver"
        )
        XCTAssertEqual(manifest.provenance.privacyReview, "approved-no-user-data")
        let specificationByFile = Dictionary(
            uniqueKeysWithValues: FrameCorpusFixtureSpecification.all.map { ($0.file, $0) }
        )
        XCTAssertEqual(manifest.fixtures.count, specificationByFile.count)
        XCTAssertEqual(Set(manifest.fixtures.map(\.file)), Set(specificationByFile.keys))
        XCTAssertEqual(Set(manifest.fixtures.map(\.sha256)).count, manifest.fixtures.count)

        for fixture in manifest.fixtures {
            XCTAssertEqual(
                fixture.file,
                URL(fileURLWithPath: fixture.file).lastPathComponent,
                "Fixture paths must be single relative file names."
            )
            let url = directory.appendingPathComponent(fixture.file)
            let data = try Data(contentsOf: url)
            let digest = SHA256.hash(data: data)
                .map { String(format: "%02x", $0) }
                .joined()
            XCTAssertEqual(digest, fixture.sha256, fixture.file)

            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
            else {
                throw CalibrationError.undecodable(fixture.file)
            }
            let specification = try XCTUnwrap(specificationByFile[fixture.file])
            XCTAssertEqual(fixture.expected, specification.expected.rawValue, fixture.file)
            XCTAssertEqual(fixture.purpose, specification.purpose, fixture.file)
            XCTAssertEqual(image.width, fixture.pixelWidth, fixture.file)
            XCTAssertEqual(image.height, fixture.pixelHeight, fixture.file)
            guard let luminance = CaptureFrameSampler.sampledLuminance(from: image) else {
                throw CalibrationError.samplingFailed(fixture.file)
            }

            let information = CaptureFrameSampler.information(
                in: luminance,
                width: CaptureFrameEconomy.sampleWidth,
                height: CaptureFrameEconomy.sampleHeight
            )

            let decision = CaptureFrameEconomy.evaluate(
                luminance: luminance,
                width: CaptureFrameEconomy.sampleWidth,
                height: CaptureFrameEconomy.sampleHeight,
                context: context,
                previous: nil
            )
            switch fixture.expected {
            case "blank":
                XCTAssertEqual(information, .blank, fixture.file)
                XCTAssertEqual(decision, .skip(.blank), fixture.file)
            case "low-information":
                XCTAssertEqual(information, .lowInformation, fixture.file)
                XCTAssertEqual(decision, .skip(.lowInformation), fixture.file)
            case "accept":
                XCTAssertEqual(information, .informative, fixture.file)
                guard case .accept = decision else {
                    XCTFail("Expected \(fixture.file) to be accepted, got \(decision).")
                    continue
                }
            default:
                XCTFail("Unsupported expected decision \(fixture.expected).")
            }
        }
    }
}
