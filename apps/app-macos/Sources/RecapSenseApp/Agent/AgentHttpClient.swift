import Foundation

struct AgentHttpClient {
  private let baseURL: URL
  private let token: String

  init(baseURL: URL, token: String) {
    self.baseURL = baseURL
    self.token = token
  }

  init(config: SupervisorConfig = SupervisorConfig.loadFromEnvironment()) throws {
    self.baseURL = config.agentUrl
    self.token = try Self.loadToken(dataDir: config.dataDir)
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

  func getMediaStats(refresh: Bool = false) async throws -> MediaStatsItem {
    var url = baseURL.appendingPathComponent("/v1/maintenance/media-stats")
    if refresh {
      var components = URLComponents(url: url, resolvingAgainstBaseURL: true)
      components?.queryItems = [
        URLQueryItem(name: "refresh", value: "1"),
      ]
      url = components?.url ?? url
    }

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

    let payload = try JSONDecoder().decode(MediaStatsResponse.self, from: data)
    return payload.stats
  }

  /// 下载一个“数据库一致快照”，用于备份（换电脑）。
  ///
  /// 注意：这是一个临时文件 URL（由 URLSession 生成），调用方应尽快 move/copy 到目标位置。
  func downloadDatabaseSnapshot() async throws -> URL {
    let url = baseURL.appendingPathComponent("/v1/backup/db")

    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

    let (fileUrl, response) = try await URLSession.shared.download(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw NSError(domain: "AgentHttpClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid response"])
    }
    guard (200..<300).contains(http.statusCode) else {
      let body = (try? String(contentsOf: fileUrl, encoding: .utf8)) ?? "HTTP \(http.statusCode)"
      throw NSError(domain: "AgentHttpClient", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: body])
    }

    return fileUrl
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

  /// 获取某一天的时间轴（按 frames 推导，支持窗口标题规范化与按 App 会话合并）。
  func getDailyTimeline(date: String) async throws -> DailyTimelineItem {
    var url = baseURL.appendingPathComponent("/v1/timeline/daily")
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

    return try JSONDecoder().decode(DailyTimelineResponse.self, from: data).timeline
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
