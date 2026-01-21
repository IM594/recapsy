import SwiftUI

struct SettingsView: View {
  @EnvironmentObject var supervisor: Supervisor

  @State private var draft: RecapSenseSettings = .defaults
  @State private var isLoading = false
  @State private var message: String? = nil

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text("设置（存储在 Agent 的 SQLite settings 表）")
          .font(.headline)
        Spacer()
        Button("刷新") { refresh() }
          .disabled(isLoading)
        Button("保存并应用") { saveAndApply() }
          .disabled(isLoading)
      }

      if let message {
        Text(message)
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      Form {
        Section("采集（Collector）") {
          Stepper(
            value: $draft.collector.intervalSeconds,
            in: 0.5...60,
            step: 0.5
          ) {
            Text("截图间隔：\(String(format: "%.1f", draft.collector.intervalSeconds)) 秒")
          }

          Stepper(value: $draft.collector.dedupeThreshold, in: 0...12) {
            Text("去重阈值（dHash 汉明距离）：\(draft.collector.dedupeThreshold)")
          }

          Toggle("写入缩略图（热证据）", isOn: $draft.collector.thumbnailEnabled)

          Stepper(value: $draft.collector.thumbnailMaxWidth, in: 200...1200, step: 20) {
            Text("缩略图最大宽度：\(draft.collector.thumbnailMaxWidth) px")
          }
        }

        Section("证据热窗口（Agent）") {
          Stepper(value: $draft.agent.evidenceRetentionDays, in: 1...3650) {
            Text("证据保留：\(draft.agent.evidenceRetentionDays) 天")
          }

          Stepper(value: $draft.agent.evidenceCleanupIntervalMinutes, in: 1...720) {
            Text("清理任务间隔：\(draft.agent.evidenceCleanupIntervalMinutes) 分钟")
          }
        }

        Section("当前环境") {
          LabeledContent("数据目录") {
            Text(supervisor.config.dataDir.path)
              .font(.caption)
              .textSelection(.enabled)
          }
          LabeledContent("Agent 地址") {
            Text(supervisor.config.agentUrl.absoluteString)
              .font(.caption)
              .textSelection(.enabled)
          }
        }
      }
    }
    .padding(16)
    .onAppear {
      draft = supervisor.settings
      refresh()
    }
  }

  private func refresh() {
    isLoading = true
    message = "正在从 Agent 读取设置…"
    Task {
      defer { isLoading = false }
      do {
        try await supervisor.refreshSettingsFromAgent()
        draft = supervisor.settings
        message = "已刷新。"
      } catch {
        message = "读取失败：\(String(describing: error))"
      }
    }
  }

  private func saveAndApply() {
    isLoading = true
    message = "正在保存并应用…"
    Task {
      defer { isLoading = false }
      do {
        try await supervisor.saveSettingsAndApply(draft)
        message = "已保存并应用。"
      } catch {
        message = "保存失败：\(String(describing: error))"
      }
    }
  }
}
