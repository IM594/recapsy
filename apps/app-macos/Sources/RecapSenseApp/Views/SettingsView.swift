import AppKit
import SwiftUI

struct SettingsView: View {
  @EnvironmentObject var supervisor: Supervisor

  @State private var draft: RecapSenseSettings = .defaults
  @State private var isLoading = false
  @State private var message: String? = nil
  @State private var excludedAppInput: String = ""
  @State private var pendingDangerScope: String? = nil
  @State private var lastDangerResult: DangerDeleteResult? = nil

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

      if let lastDangerResult {
        Text(
          "删除完成：frames=\(lastDangerResult.deletedFrames)，chunks=\(lastDangerResult.deletedChunks)，日总结=\(lastDangerResult.deletedDailySummaries)"
        )
        .font(.caption)
        .foregroundStyle(.secondary)
      }

      Form {
        Section("危险区域（Danger Zone）") {
          Text("删除是不可恢复的。建议先“暂停采集”，再执行删除。")
            .font(.caption)
            .foregroundStyle(.secondary)

          Button("删除最近 1 小时") { pendingDangerScope = "lastHour" }
            .disabled(isLoading)
          Button("删除最近 24 小时") { pendingDangerScope = "lastDay" }
            .disabled(isLoading)
          Button("删除全部数据（清空）") { pendingDangerScope = "all" }
            .disabled(isLoading)
        }

        Section("权限（macOS）") {
          Button("打开系统设置：屏幕录制") {
            openPrivacyPane(anchor: "Privacy_ScreenCapture")
          }
          Button("打开系统设置：辅助功能") {
            openPrivacyPane(anchor: "Privacy_Accessibility")
          }

          Text("提示：如果 Collector 提示“无法截屏”，通常需要在这里给对应进程授权（可能是 recapsense-collector，也可能是启动它的 App）。")
            .font(.caption)
            .foregroundStyle(.secondary)

          LabeledContent("Collector 实际可执行文件") {
            Text(supervisor.config.collectorBinary.path)
              .font(.caption)
              .textSelection(.enabled)
          }

          LabeledContent("Collector 构建产物路径（开发）") {
            Text(supervisor.config.collectorBuiltBinary.path)
              .font(.caption)
              .textSelection(.enabled)
          }
        }

        Section("采集（Collector）") {
          LabeledContent("采集开关（本机）") {
            Text(supervisor.collectorEnabled ? "已开启" : "已关闭")
              .font(.caption)
              .foregroundStyle(.secondary)
          }

          LabeledContent("托管 PID（本 App 拉起）") {
            Text(supervisor.collectorDiagnostics.managedPid.map(String.init) ?? "—")
              .font(.caption)
              .textSelection(.enabled)
          }

          LabeledContent("锁文件 PID（dataDir/run/collector.lock）") {
            Text(supervisor.collectorDiagnostics.lockPid.map(String.init) ?? "—")
              .font(.caption)
              .textSelection(.enabled)
          }

          LabeledContent("检测到的 collector 实例数") {
            Text(String(supervisor.collectorDiagnostics.relatedCount))
              .font(.caption)
              .textSelection(.enabled)
          }

          if supervisor.collectorDiagnostics.hasMultipleInstances {
            Text("警告：检测到多个 collector 实例。为避免黑名单/日志错乱，App 会自动尝试修复。")
              .font(.caption)
              .foregroundStyle(.red)
          }

          if supervisor.collectorDiagnostics.autoFixing {
            Text("正在自动修复 collector 多实例/残留进程…")
              .font(.caption)
              .foregroundStyle(.secondary)
          } else if let message = supervisor.collectorDiagnostics.lastAutoFixMessage {
            Text(message)
              .font(.caption)
              .foregroundStyle(.secondary)
          }

          if !supervisor.collectorDiagnostics.processes.isEmpty {
            ForEach(supervisor.collectorDiagnostics.processes) { proc in
              Text("pid \(proc.pid)：\(proc.path)")
                .font(.caption)
                .textSelection(.enabled)
            }
          }

          Divider()

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

          Divider()

          Text("应用黑名单（不采集）")
            .font(.subheadline)

          if draft.collector.excludedApps.isEmpty {
            Text("暂无黑名单。")
              .font(.caption)
              .foregroundStyle(.secondary)
          } else {
            ForEach(draft.collector.excludedApps, id: \.self) { app in
              HStack {
                Text(app)
                  .font(.caption)
                Spacer()
                Button("移除") {
                  draft.collector.excludedApps.removeAll { $0 == app }
                }
                .buttonStyle(.borderless)
              }
            }
          }

          HStack {
            TextField("例如：Google Chrome", text: $excludedAppInput)
            Button("添加") { addExcludedApp(excludedAppInput) }
              .disabled(excludedAppInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("添加当前前台应用") { addFrontmostAppToBlacklist() }
          }

          Text("提示：这里填写的是 macOS 显示的应用名称（菜单栏左上角的 App 名称）。")
            .font(.caption)
            .foregroundStyle(.secondary)
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
    .alert(
      "确认删除？",
      isPresented: Binding(
        get: { pendingDangerScope != nil },
        set: { newValue in if !newValue { pendingDangerScope = nil } }
      )
    ) {
      Button("取消", role: .cancel) { pendingDangerScope = nil }
      Button("确认删除", role: .destructive) {
        let scope = pendingDangerScope ?? "lastHour"
        pendingDangerScope = nil
        runDangerDelete(scope: scope)
      }
    } message: {
      Text(dangerMessage(for: pendingDangerScope))
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

  private func runDangerDelete(scope: String) {
    isLoading = true
    lastDangerResult = nil
    message = "正在删除…（\(scope)）"
    Task {
      defer { isLoading = false }
      do {
        let result = try await supervisor.dangerDelete(scope: scope)
        lastDangerResult = result
        switch scope {
        case "all":
          message = "已删除全部数据（已清空）。"
        case "lastDay":
          message = "已删除最近 24 小时的数据。"
        case "lastHour":
          message = "已删除最近 1 小时的数据。"
        default:
          message = "已删除。"
        }
      } catch {
        message = "删除失败：\(String(describing: error))"
      }
    }
  }

  private func dangerMessage(for scope: String?) -> String {
    switch scope {
    case "all":
      return "将清空数据库中的 frames/chunks/日总结，并删除热证据（media 目录）。这一步不可恢复。"
    case "lastDay":
      return "将删除最近 24 小时内的内容（如果某个 chunk 有一部分命中范围，会删除整个 chunk 以及关联的 frames）。不可恢复。"
    case "lastHour":
      return "将删除最近 1 小时内的内容（如果某个 chunk 有一部分命中范围，会删除整个 chunk 以及关联的 frames）。不可恢复。"
    default:
      return "这一步不可恢复。"
    }
  }

  private func addExcludedApp(_ raw: String) {
    let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty else { return }
    if !draft.collector.excludedApps.contains(name) {
      draft.collector.excludedApps.append(name)
      draft.collector.excludedApps.sort()
    }
    excludedAppInput = ""
  }

  private func addFrontmostAppToBlacklist() {
    let name = NSWorkspace.shared.frontmostApplication?.localizedName ?? ""
    addExcludedApp(name)
  }
}

private func openPrivacyPane(anchor: String) {
  guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") else {
    return
  }
  NSWorkspace.shared.open(url)
}
