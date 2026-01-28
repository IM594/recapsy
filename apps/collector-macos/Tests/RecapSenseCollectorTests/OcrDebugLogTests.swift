import XCTest

@testable import RecapSenseCollector

final class OcrDebugLogTests: XCTestCase {
  func testRotateCreatesDot1AndContinuesWriting() throws {
    let dir = try makeTempDir(prefix: "recapsense-collector-ocr-log")
    let logsDir = dir.appendingPathComponent("logs", isDirectory: true)

    let log = try OcrDebugLog(logsDir: logsDir, maxBytes: 20)
    log.append("01234567890123456789\n")
    log.append("again\n")

    let main = logsDir.appendingPathComponent("collector-ocr.log")
    let rotated = logsDir.appendingPathComponent("collector-ocr.log.1")

    XCTAssertTrue(FileManager.default.fileExists(atPath: main.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: rotated.path))

    let rotatedText = try String(contentsOf: rotated, encoding: .utf8)
    XCTAssertTrue(rotatedText.contains("0123456789"))
  }
}

