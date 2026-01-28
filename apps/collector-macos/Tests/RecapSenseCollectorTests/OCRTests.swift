import XCTest

@testable import RecapSenseCollector

final class OCRTests: XCTestCase {
  func testNormalizeTextTrimsAndSquashes() throws {
    let raw = " \tHello\r\n\r\n  World \n\n"
    XCTAssertEqual(normalizeText(raw), "Hello\nWorld")
  }

  func testEvaluateOCRTextQualityAndUpgradeHeuristic() throws {
    let repeated = Array(repeating: "你好世界", count: 25).joined(separator: "")
    let good = "\(repeated)\nhello 123"
    let qualityGood = evaluateOCRTextQuality(good)
    XCTAssertEqual(qualityGood.lines, 2)
    XCTAssertGreaterThan(qualityGood.goodChars, 0)
    XCTAssertGreaterThanOrEqual(qualityGood.goodRatio, 0)

    XCTAssertFalse(shouldUpgradeFastOCR(qualityGood))

    let tooShort = "hi"
    let qualityShort = evaluateOCRTextQuality(tooShort)
    XCTAssertTrue(shouldUpgradeFastOCR(qualityShort))

    let weird = String(repeating: "È", count: 20) + "abc"
    let qualityWeird = evaluateOCRTextQuality(weird)
    XCTAssertTrue(shouldUpgradeFastOCR(qualityWeird))
    XCTAssertGreaterThan(qualityWeird.weirdChars, 0)
  }
}
