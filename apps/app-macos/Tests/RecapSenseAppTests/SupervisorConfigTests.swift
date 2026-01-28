import XCTest

@testable import RecapSenseApp

final class SupervisorConfigTests: XCTestCase {
  func testLoadFromEnvironmentHonorsRepoRootAndDataDir() throws {
    let repoRoot = try makeTempDir(prefix: "recapsense-app-repo-root")
    let packageJson = repoRoot.appendingPathComponent("package.json")
    let agentServer = repoRoot.appendingPathComponent("apps/agent/src/server.mjs")
    try FileManager.default.createDirectory(
      at: agentServer.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    try "{}\n".data(using: .utf8)!.write(to: packageJson)
    try "// ok\n".data(using: .utf8)!.write(to: agentServer)

    let dataDir = try makeTempDir(prefix: "recapsense-app-data-dir")

    withEnvVar("RECAPSENSE_REPO_ROOT", repoRoot.path) {
      withEnvVar("RECAPSENSE_DATA_DIR", dataDir.path) {
        let cfg = SupervisorConfig.loadFromEnvironment()
        XCTAssertEqual(cfg.repoRoot.standardizedFileURL.path, repoRoot.standardizedFileURL.path)
        XCTAssertEqual(cfg.dataDir.standardizedFileURL.path, dataDir.standardizedFileURL.path)
        XCTAssertEqual(cfg.logsDir.path, dataDir.appendingPathComponent("logs").path)
      }
    }
  }

  func testLoadFromEnvironmentResolvesNodeOverride() throws {
    let dir = try makeTempDir(prefix: "recapsense-app-node-bin")
    let fakeNode = dir.appendingPathComponent("node")
    FileManager.default.createFile(atPath: fakeNode.path, contents: Data())

    withEnvVar("RECAPSENSE_NODE_BIN", fakeNode.path) {
      let cfg = SupervisorConfig.loadFromEnvironment()
      XCTAssertEqual(cfg.node.executable, fakeNode.path)
      XCTAssertEqual(cfg.node.argumentsPrefix, [])
    }
  }
}
