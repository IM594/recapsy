import Foundation

struct AgentHttpClient {
  private let baseURL: URL
  private let token: String

  init() throws {
    let env = ProcessInfo.processInfo.environment

    let baseURL = URL(string: env["RECAPSENSE_AGENT_URL"] ?? "http://127.0.0.1:4832")
      ?? URL(string: "http://127.0.0.1:4832")!

    let repoRoot = URL(fileURLWithPath: env["RECAPSENSE_REPO_ROOT"] ?? FileManager.default.currentDirectoryPath)
    let dataDir = URL(fileURLWithPath: env["RECAPSENSE_DATA_DIR"] ?? repoRoot.appendingPathComponent(".recapsense").path)

    let token = try Self.loadToken(dataDir: dataDir)

    self.baseURL = baseURL
    self.token = token
  }

  func getSettings() async throws -> RecapSenseSettings {
    let url = baseURL.appendingPathComponent("/v1/settings")

    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw NSError(domain: "AgentHttpClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid response"])
    }
    guard (200..<300).contains(http.statusCode) else {
      let body = String(decoding: data, as: UTF8.self)
      throw NSError(domain: "AgentHttpClient", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: body])
    }

    struct Payload: Decodable { let settings: RecapSenseSettings }
    return try JSONDecoder().decode(Payload.self, from: data).settings
  }

  func patchSettings(_ patch: RecapSenseSettings) async throws -> RecapSenseSettings {
    let url = baseURL.appendingPathComponent("/v1/settings")

    var request = URLRequest(url: url)
    request.httpMethod = "PATCH"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")

    request.httpBody = try JSONEncoder().encode(patch)

    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw NSError(domain: "AgentHttpClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid response"])
    }
    guard (200..<300).contains(http.statusCode) else {
      let body = String(decoding: data, as: UTF8.self)
      throw NSError(domain: "AgentHttpClient", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: body])
    }

    struct Payload: Decodable { let settings: RecapSenseSettings }
    return try JSONDecoder().decode(Payload.self, from: data).settings
  }

  func getChunk(id: String) async throws -> ChunkItem {
    let url = baseURL.appendingPathComponent("/v1/chunks/\(id)")

    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw NSError(domain: "AgentHttpClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid response"])
    }
    guard (200..<300).contains(http.statusCode) else {
      let body = String(decoding: data, as: UTF8.self)
      throw NSError(domain: "AgentHttpClient", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: body])
    }

    struct Payload: Decodable { let chunk: ChunkItem }
    return try JSONDecoder().decode(Payload.self, from: data).chunk
  }

  /// 获取（并尽力生成）日总结；如果当天没有 chunks，Agent 会返回 `summary: null`。
  func getDailySummary(date: String) async throws -> DailySummaryItem? {
    var url = baseURL.appendingPathComponent("/v1/summaries/daily")
    var components = URLComponents(url: url, resolvingAgainstBaseURL: true)
    components?.queryItems = [
      URLQueryItem(name: "date", value: date),
    ]
    url = components?.url ?? url

    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw NSError(domain: "AgentHttpClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid response"])
    }
    guard (200..<300).contains(http.statusCode) else {
      let body = String(decoding: data, as: UTF8.self)
      throw NSError(domain: "AgentHttpClient", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: body])
    }

    struct Payload: Decodable { let summary: DailySummaryItem? }
    return try JSONDecoder().decode(Payload.self, from: data).summary
  }

  func search(query: String, limit: Int) async throws -> [SearchResultItem] {
    var url = baseURL.appendingPathComponent("/v1/search")
    var components = URLComponents(url: url, resolvingAgainstBaseURL: true)
    components?.queryItems = [
      URLQueryItem(name: "q", value: query),
      URLQueryItem(name: "limit", value: String(limit)),
    ]
    url = components?.url ?? url

    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw NSError(domain: "AgentHttpClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid response"])
    }
    guard (200..<300).contains(http.statusCode) else {
      let body = String(decoding: data, as: UTF8.self)
      throw NSError(domain: "AgentHttpClient", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: body])
    }

    struct Payload: Decodable { let results: [SearchResultItem] }
    return try JSONDecoder().decode(Payload.self, from: data).results
  }

  func dangerDelete(scope: String) async throws -> DangerDeleteResult {
    let url = baseURL.appendingPathComponent("/v1/danger/delete")

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")

    struct Body: Encodable { let scope: String }
    request.httpBody = try JSONEncoder().encode(Body(scope: scope))

    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw NSError(domain: "AgentHttpClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid response"])
    }
    guard (200..<300).contains(http.statusCode) else {
      let body = String(decoding: data, as: UTF8.self)
      throw NSError(domain: "AgentHttpClient", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: body])
    }

    let payload = try JSONDecoder().decode(DangerDeleteResponse.self, from: data)
    return payload.result
  }

  /// 关闭 Agent（用于“外部进程已存在/端口占用”时的兜底）。
  ///
  /// 注意：这是本机工具进程的开发期能力；生产期可根据需要收敛/加固。
  func shutdown() async throws {
    let url = baseURL.appendingPathComponent("/v1/maintenance/shutdown")

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw NSError(domain: "AgentHttpClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid response"])
    }
    guard (200..<300).contains(http.statusCode) || http.statusCode == 202 else {
      let body = String(decoding: data, as: UTF8.self)
      throw NSError(domain: "AgentHttpClient", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: body])
    }
  }

  private static func loadToken(dataDir: URL) throws -> String {
    let env = ProcessInfo.processInfo.environment
    if let token = env["RECAPSENSE_API_TOKEN"], !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return token.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    let tokenFile = dataDir.appendingPathComponent("secret/token")
    let raw = try String(contentsOf: tokenFile, encoding: .utf8)
    let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if token.isEmpty {
      throw NSError(domain: "AgentHttpClient", code: -2, userInfo: [NSLocalizedDescriptionKey: "token 为空：\(tokenFile.path)"])
    }
    return token
  }
}
