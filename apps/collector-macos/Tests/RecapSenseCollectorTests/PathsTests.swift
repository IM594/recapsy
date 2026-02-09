import XCTest

@testable import RecapSenseCollector

final class PathsTests: XCTestCase {
  func testResolveDataDirUsesEnv() throws {
    withEnvVar("RECAPSENSE_DATA_DIR", "/tmp/recapsense-test-data-dir") {
      let dir = resolveDataDir()
      XCTAssertEqual(dir.path, "/tmp/recapsense-test-data-dir")
    }
  }

  func testResolveDataDirDefaultsToDotRecapsense() throws {
    withEnvVar("RECAPSENSE_DATA_DIR", nil) {
      let dir = resolveDataDir()
      XCTAssertTrue(dir.path.hasSuffix("/.recapsense"))
    }
  }

  func testCollectorPathsBuildsTokenAndMediaPaths() throws {
    let dataDir = URL(fileURLWithPath: "/tmp/recapsense-data", isDirectory: true)
    let paths = CollectorPaths(dataDir: dataDir)
    XCTAssertEqual(paths.tokenFile.path, "/tmp/recapsense-data/secret/token")
    XCTAssertEqual(
      paths.screenshotRelativePath(date: "2026-01-27", filename: "a.webp"),
      "media/screenshots/2026-01-27/a.webp"
    )
    XCTAssertEqual(
      paths.screenshotAbsoluteURL(relativePath: "media/screenshots/2026-01-27/a.webp").path,
      "/tmp/recapsense-data/media/screenshots/2026-01-27/a.webp"
    )
  }

  func testLoadTokenPrefersEnv() throws {
    try withEnvVar("RECAPSENSE_API_TOKEN", "  abc123 \n") {
      let token = try loadToken(dataDir: URL(fileURLWithPath: "/tmp/irrelevant", isDirectory: true))
      XCTAssertEqual(token, "abc123")
    }
  }

  func testLoadTokenReadsFile() throws {
    try withEnvVar("RECAPSENSE_API_TOKEN", nil) {
      let dir = try makeTempDir(prefix: "recapsense-collector-token")
      let tokenFile = CollectorPaths(dataDir: dir).tokenFile
      try FileManager.default.createDirectory(
        at: tokenFile.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      try "file-token\n".data(using: .utf8)!.write(to: tokenFile)

      let token = try loadToken(dataDir: dir)
      XCTAssertEqual(token, "file-token")
    }
  }

  func testLoadTokenEmptyFileThrows() throws {
    try withEnvVar("RECAPSENSE_API_TOKEN", nil) {
      let dir = try makeTempDir(prefix: "recapsense-collector-token-empty")
      let tokenFile = CollectorPaths(dataDir: dir).tokenFile
      try FileManager.default.createDirectory(
        at: tokenFile.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      try "\n".data(using: .utf8)!.write(to: tokenFile)

      XCTAssertThrowsError(try loadToken(dataDir: dir))
    }
  }

  func testResolveAgentBaseURLDefaultAndInvalidEnv() throws {
    try withEnvVar("RECAPSENSE_AGENT_URL", nil) {
      let url = try resolveAgentBaseURL()
      XCTAssertEqual(url.absoluteString, "http://127.0.0.1:4832")
    }

    try withEnvVar("RECAPSENSE_AGENT_URL", "http://[::1") {
      XCTAssertThrowsError(try resolveAgentBaseURL())
    }
  }
}
