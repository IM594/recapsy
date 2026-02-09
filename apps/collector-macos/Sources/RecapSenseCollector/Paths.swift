import Foundation

struct CollectorPaths {
  let dataDir: URL

  var tokenFile: URL {
    dataDir.appendingPathComponent("secret/token")
  }

  func screenshotRelativePath(date: String, filename: String) -> String {
    "media/screenshots/\(date)/\(filename)"
  }

  func screenshotAbsoluteURL(relativePath: String) -> URL {
    dataDir.appendingPathComponent(relativePath)
  }
}

func resolveDataDir() -> URL {
  if let env = ProcessInfo.processInfo.environment["RECAPSENSE_DATA_DIR"], !env.isEmpty {
    return URL(fileURLWithPath: env, isDirectory: true)
  }
  return URL(fileURLWithPath: ".recapsense", isDirectory: true)
}

func loadToken(dataDir: URL) throws -> String {
  if let token = ProcessInfo.processInfo.environment["RECAPSENSE_API_TOKEN"], !token.isEmpty {
    return token.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  let tokenFile = CollectorPaths(dataDir: dataDir).tokenFile
  let data = try Data(contentsOf: tokenFile)
  let token = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
  if token.isEmpty {
    throw NSError(domain: "recapsense.collector", code: 2, userInfo: [
      NSLocalizedDescriptionKey: "token 文件为空：\(tokenFile.path)",
    ])
  }
  return token
}

func resolveAgentBaseURL() throws -> URL {
  let raw = ProcessInfo.processInfo.environment["RECAPSENSE_AGENT_URL"] ?? "http://127.0.0.1:4832"
  guard let url = URL(string: raw) else {
    throw NSError(domain: "recapsense.collector", code: 3, userInfo: [
      NSLocalizedDescriptionKey: "RECAPSENSE_AGENT_URL 无效：\(raw)",
    ])
  }
  return url
}
