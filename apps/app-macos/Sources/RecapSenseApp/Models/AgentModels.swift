import Foundation

// 说明：这些模型与 Agent 的 JSON 输出对齐。
// 当前我们保持字段名与 JSON 一致（snake_case），避免引入额外的 key decoding 策略，先保证稳定与直观。

struct SearchResultItem: Decodable, Identifiable, Equatable {
  let id: String
  let start_ts: Int64
  let end_ts: Int64
  let app: String?
  let window_title: String?
  let snippet: String?
  let score: Double?
}

struct ChunkItem: Decodable, Identifiable, Equatable {
  let id: String
  let start_ts: Int64
  let end_ts: Int64
  let app: String?
  let window_title: String?
  let text: String
}

struct DailySummaryItem: Decodable, Equatable {
  let date: String
  let start_ts: Int64
  let end_ts: Int64
  let summary: String
}

