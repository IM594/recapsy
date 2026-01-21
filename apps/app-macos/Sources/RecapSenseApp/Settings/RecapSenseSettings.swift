import Foundation

/// 与 Agent 的 `/v1/settings` 对齐的设置结构。
///
/// 原则：
/// - 设置存在 Agent 的 SQLite `settings` 表里（跨 UI/collector 统一）。
/// - UI 只负责读/改；具体策略由 Agent 执行（例如证据清理任务）。
struct RecapSenseSettings: Codable, Equatable {
  struct Collector: Codable, Equatable {
    var intervalSeconds: Double
    var dedupeThreshold: Int
    var thumbnailEnabled: Bool
    var thumbnailMaxWidth: Int
    var ocrLevel: String
    var ocrLanguages: [String]
  }

  struct Agent: Codable, Equatable {
    var evidenceRetentionDays: Int
    var evidenceCleanupIntervalMinutes: Int
  }

  var collector: Collector
  var agent: Agent

  static var defaults: RecapSenseSettings {
    RecapSenseSettings(
      collector: Collector(
        intervalSeconds: 5,
        dedupeThreshold: 2,
        thumbnailEnabled: true,
        thumbnailMaxWidth: 420,
        ocrLevel: "fast",
        ocrLanguages: ["zh-Hans", "en-US"]
      ),
      agent: Agent(
        evidenceRetentionDays: 30,
        evidenceCleanupIntervalMinutes: 60
      )
    )
  }
}

