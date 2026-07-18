import CaptureCore
import Foundation
import ImageIO
import XCTest

final class CaptureFrameEconomyCorpusTests: XCTestCase {
    private enum FixtureError: Error {
        case missing(String)
        case undecodable(String)
        case samplingFailed(String)
        case notAccepted(String)
    }

    private let context = CaptureFrameContext(
        bundleId: "one.recapsy.fixture",
        windowId: 101
    )

    func testEncodedBlankScreenshotCorpusIsSkipped() throws {
        for name in ["blank-surface", "blank-six-level-band"] {
            XCTAssertEqual(
                try decision(for: name),
                .skip(.blank),
                name
            )
        }

        let boundary = try sampledLuminance(for: "blank-six-level-band")
        let darkest = try XCTUnwrap(boundary.min())
        let brightest = try XCTUnwrap(boundary.max())
        XCTAssertEqual(brightest - darkest, 6)
    }

    func testEncodedDuplicateBoundarySkipsExactFrameAndCompositorJitter() throws {
        let baseline = try acceptedFingerprint(for: "application-base")
        let baselineLuminance = try sampledLuminance(for: "application-base")
        let jitterLuminance = try sampledLuminance(for: "application-compositor-jitter")

        XCTAssertNotEqual(jitterLuminance, baselineLuminance)
        XCTAssertEqual(maximumDifference(baselineLuminance, jitterLuminance), 1)

        XCTAssertEqual(
            try decision(for: "application-base", previous: baseline),
            .skip(.duplicate)
        )
        XCTAssertEqual(
            try decision(for: "application-compositor-jitter", previous: baseline),
            .skip(.duplicate)
        )
    }

    func testEncodedSmallUIAndContentChangesRemainAdmitted() throws {
        let baseline = try acceptedFingerprint(for: "application-base")
        let baselineLuminance = try sampledLuminance(for: "application-base")
        let statusChangeCount = changedSampleCount(
            baselineLuminance,
            try sampledLuminance(for: "application-status-change")
        )
        let contentChangeCount = changedSampleCount(
            baselineLuminance,
            try sampledLuminance(for: "application-content-change")
        )

        XCTAssertGreaterThan(statusChangeCount, 0)
        XCTAssertLessThanOrEqual(statusChangeCount, 4)
        XCTAssertGreaterThan(contentChangeCount, statusChangeCount)

        for name in ["application-status-change", "application-content-change"] {
            guard case .accept = try decision(for: name, previous: baseline) else {
                XCTFail("Expected encoded fixture \(name) to be admitted.")
                continue
            }
        }
    }

    private func acceptedFingerprint(for name: String) throws -> CaptureFrameFingerprint {
        guard case let .accept(fingerprint) = try decision(for: name) else {
            throw FixtureError.notAccepted(name)
        }
        return fingerprint
    }

    private func decision(
        for name: String,
        previous: CaptureFrameFingerprint? = nil
    ) throws -> CaptureFrameEconomyDecision {
        let luminance = try sampledLuminance(for: name)
        return CaptureFrameEconomy.evaluate(
            luminance: luminance,
            width: CaptureFrameEconomy.sampleWidth,
            height: CaptureFrameEconomy.sampleHeight,
            context: context,
            previous: previous
        )
    }

    private func sampledLuminance(for name: String) throws -> [UInt8] {
        guard let url = Bundle.module.url(
            forResource: name,
            withExtension: "png"
        ) else {
            throw FixtureError.missing(name)
        }
        let data = try Data(contentsOf: url)
        XCTAssertLessThan(data.count, 20_000, "Fixture \(name) should stay reviewably small.")

        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else {
            throw FixtureError.undecodable(name)
        }
        XCTAssertEqual(image.width, 480, name)
        XCTAssertEqual(image.height, 270, name)

        guard let luminance = CaptureFrameSampler.sampledLuminance(from: image) else {
            throw FixtureError.samplingFailed(name)
        }
        return luminance
    }

    private func changedSampleCount(_ left: [UInt8], _ right: [UInt8]) -> Int {
        return zip(left, right).reduce(into: 0) { count, pair in
            if pair.0 != pair.1 {
                count += 1
            }
        }
    }

    private func maximumDifference(_ left: [UInt8], _ right: [UInt8]) -> UInt8 {
        return zip(left, right).reduce(into: UInt8(0)) { maximum, pair in
            let difference = pair.0 >= pair.1 ? pair.0 - pair.1 : pair.1 - pair.0
            maximum = max(maximum, difference)
        }
    }
}
