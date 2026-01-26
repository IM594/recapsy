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

struct DangerDeleteResult: Decodable, Equatable {
  let scope: String
  let startTs: Int64
  let endTs: Int64
  let deletedFrames: Int
  let deletedChunks: Int
  let deletedDailySummaries: Int
}

struct DangerDeleteResponse: Decodable, Equatable {
  let result: DangerDeleteResult
}

struct MediaStatsItem: Decodable, Equatable {
  let totalBytes: Int64
  let fileCount: Int
  let thresholdBytes: Int64
  let overThreshold: Bool
  let scannedAt: Int64
}

struct MediaStatsResponse: Decodable, Equatable {
  let stats: MediaStatsItem
}

// MARK: - Timeline

struct TimelineAppTotalItem: Decodable, Equatable, Identifiable {
  var id: String { app ?? "" }

  let app: String?
  let active_ms: Int64
  let frame_count: Int
  let span_count: Int
  let session_count: Int
  let first_ts: Int64?
  let last_ts: Int64?
}

struct TimelineSessionItem: Decodable, Equatable, Identifiable {
  let id: String
  let start_ts: Int64
  let end_ts: Int64
  let active_ms: Int64
  let app: String?
  let span_count: Int
  let titles: [String]
}

struct TimelineSpanItem: Decodable, Equatable, Identifiable {
  let id: String
  let start_ts: Int64
  let end_ts: Int64
  let active_ms: Int64
  let app: String?
  let window_title: String?
  let window_title_norm: String
  let frame_count: Int
  let chunk_count: Int
  let chunk_ids: [String]
  let sample_chunk_id: String?
}

struct DailyTimelineItem: Decodable, Equatable {
  let date: String
  let start_ts: Int64
  let end_ts: Int64
  let split_gap_ms: Int64
  let session_merge_gap_ms: Int64
  let apps: [TimelineAppTotalItem]
  let sessions: [TimelineSessionItem]
  let spans: [TimelineSpanItem]
}

struct DailyTimelineResponse: Decodable, Equatable {
  let timeline: DailyTimelineItem
}
