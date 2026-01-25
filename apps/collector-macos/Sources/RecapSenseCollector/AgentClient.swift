import Foundation

struct AgentClientConfig {
  let baseURL: URL
  let token: String
  let timeoutSeconds: TimeInterval
}

struct IngestFrameRequestBody: Encodable {
  let ts: Int64
  let app: String?
  let appBundleId: String?
  let windowTitle: String?
  let ocrText: String
  let phash: String?
  let screenshotPath: String?
  let thumbnailPath: String?
}

struct IngestFrameResult: Equatable {
  let id: Int64?
  let skipped: Bool
  let reason: String?
}

enum AgentClientError: Error, CustomStringConvertible {
  case invalidURL(String)
  case requestFailed(String)
  case serverError(status: Int, message: String)

  var description: String {
    switch self {
    case .invalidURL(let message):
      return "URL 无效：\(message)"
    case .requestFailed(let message):
      return "请求失败：\(message)"
    case .serverError(let status, let message):
      return "Agent 返回错误（HTTP \(status)）：\(message)"
    }
  }
}

final class AgentClient {
  private let config: AgentClientConfig
  private let session: URLSession

  init(config: AgentClientConfig) {
    self.config = config

    let sessionConfig = URLSessionConfiguration.ephemeral
    sessionConfig.timeoutIntervalForRequest = config.timeoutSeconds
    sessionConfig.timeoutIntervalForResource = config.timeoutSeconds
    self.session = URLSession(configuration: sessionConfig)
  }

  func ingestFrame(_ body: IngestFrameRequestBody) async throws -> IngestFrameResult {
    let url = config.baseURL.appendingPathComponent("/v1/ingest/frame")
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
    request.httpBody = try JSONEncoder().encode(body)

    let (data, response) = try await session.data(for: request)
    let http = response as? HTTPURLResponse
    let status = http?.statusCode ?? 0

    if status < 200 || status >= 300 {
      let message = decodeJsonErrorMessage(from: data) ?? String(data: data, encoding: .utf8) ?? "未知错误"
      throw AgentClientError.serverError(status: status, message: message)
    }

    // 返回形如：
    // - 成功：{ frame: { id: 123 } }
    // - 被 Agent 丢弃：HTTP 202 { frame: { skipped: true, reason: "excluded-app" } }
    struct ResponseBody: Decodable {
      struct Frame: Decodable {
        let id: Int64?
        let skipped: Bool?
        let reason: String?
      }
      let frame: Frame?
    }

    let decoded = try? JSONDecoder().decode(ResponseBody.self, from: data)
    let frame = decoded?.frame

    // 兼容：如果 body 无法解析，但 status=202，我们仍视为 skipped。
    let skipped = frame?.skipped ?? (status == 202)
    return IngestFrameResult(id: frame?.id, skipped: skipped, reason: frame?.reason)
  }

  private func decodeJsonErrorMessage(from data: Data) -> String? {
    struct ErrorBody: Decodable { let error: String? }
    guard let decoded = try? JSONDecoder().decode(ErrorBody.self, from: data) else { return nil }
    return decoded.error
  }
}
