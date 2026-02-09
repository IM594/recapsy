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
    var ocrLevel: String
    var ocrLanguages: [String]
    var excludedApps: [String]

    enum CodingKeys: String, CodingKey {
      case intervalSeconds
      case dedupeThreshold
      case ocrLevel
      case ocrLanguages
      case excludedApps
    }

    init(
      intervalSeconds: Double,
      dedupeThreshold: Int,
      ocrLevel: String,
      ocrLanguages: [String],
      excludedApps: [String]
    ) {
      self.intervalSeconds = intervalSeconds
      self.dedupeThreshold = dedupeThreshold
      self.ocrLevel = ocrLevel
      self.ocrLanguages = ocrLanguages
      self.excludedApps = excludedApps
    }

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      let defaults = RecapSenseSettings.defaults.collector
      intervalSeconds = try c.decodeIfPresent(Double.self, forKey: .intervalSeconds) ?? defaults.intervalSeconds
      dedupeThreshold = try c.decodeIfPresent(Int.self, forKey: .dedupeThreshold) ?? defaults.dedupeThreshold
      ocrLevel = try c.decodeIfPresent(String.self, forKey: .ocrLevel) ?? defaults.ocrLevel
      ocrLanguages = try c.decodeIfPresent([String].self, forKey: .ocrLanguages) ?? defaults.ocrLanguages
      excludedApps = try c.decodeIfPresent([String].self, forKey: .excludedApps) ?? defaults.excludedApps
    }
  }

  struct Agent: Codable, Equatable {
    var evidenceRetentionDays: Int
    var evidenceCleanupIntervalMinutes: Int
    var mediaWarnThresholdBytes: Int

    enum CodingKeys: String, CodingKey {
      case evidenceRetentionDays
      case evidenceCleanupIntervalMinutes
      case mediaWarnThresholdBytes
    }

    init(
      evidenceRetentionDays: Int,
      evidenceCleanupIntervalMinutes: Int,
      mediaWarnThresholdBytes: Int
    ) {
      self.evidenceRetentionDays = evidenceRetentionDays
      self.evidenceCleanupIntervalMinutes = evidenceCleanupIntervalMinutes
      self.mediaWarnThresholdBytes = mediaWarnThresholdBytes
    }

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      let defaults = RecapSenseSettings.defaults.agent
      evidenceRetentionDays = try c.decodeIfPresent(Int.self, forKey: .evidenceRetentionDays) ?? defaults.evidenceRetentionDays
      evidenceCleanupIntervalMinutes = try c.decodeIfPresent(Int.self, forKey: .evidenceCleanupIntervalMinutes) ?? defaults.evidenceCleanupIntervalMinutes
      mediaWarnThresholdBytes = try c.decodeIfPresent(Int.self, forKey: .mediaWarnThresholdBytes) ?? defaults.mediaWarnThresholdBytes
    }
  }

  var collector: Collector
  var agent: Agent

  static var defaults: RecapSenseSettings {
    RecapSenseSettings(
      collector: Collector(
        intervalSeconds: 5,
        dedupeThreshold: 2,
        ocrLevel: "fast",
        ocrLanguages: ["zh-Hans", "en-US"],
        excludedApps: []
      ),
      agent: Agent(
        evidenceRetentionDays: 365,
        evidenceCleanupIntervalMinutes: 60,
        mediaWarnThresholdBytes: 10 * 1024 * 1024 * 1024
      )
    )
  }
}
