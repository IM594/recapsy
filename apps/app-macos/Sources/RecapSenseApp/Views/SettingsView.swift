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
          LabeledContent("采集器屏幕录制") {
            PermissionStatusView(
              granted: supervisor.collectorPermissionDiagnostics.screenRecordingGranted,
              missingText: "未授权（无法采集）"
            )
          }

          LabeledContent("采集器辅助功能") {
            PermissionStatusView(
              granted: supervisor.collectorPermissionDiagnostics.accessibilityGranted,
              missingText: "未授权（标题可能不准确）"
            )
          }

          if supervisor.collectorPermissionDiagnostics.checking {
            Text("正在检查采集器权限…")
              .font(.caption)
              .foregroundStyle(.secondary)
          } else if let error = supervisor.collectorPermissionDiagnostics.lastErrorMessage, !error.isEmpty {
            Text("权限检查失败：\(error)")
              .font(.caption)
              .foregroundStyle(.secondary)
          } else if let checkedAt = supervisor.collectorPermissionDiagnostics.lastCheckedAt {
            Text("上次检查：\(checkedAt.formatted(date: .numeric, time: .standard))")
              .font(.caption)
              .foregroundStyle(.secondary)
          }

          Button("立即检查采集器权限") {
            supervisor.checkCollectorPermissionsNow()
          }

          Button("打开系统设置：屏幕录制") {
            PrivacyPane.openScreenCapture()
          }
          Button("打开系统设置：辅助功能") {
            PrivacyPane.openAccessibility()
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

          Text("应用黑名单（按身份，不采集）")
            .font(.subheadline)

          if draft.collector.excludedApps.isEmpty {
            Text("暂无黑名单。")
              .font(.caption)
              .foregroundStyle(.secondary)
          } else {
            ForEach(draft.collector.excludedApps, id: \.self) { app in
              HStack {
                VStack(alignment: .leading, spacing: 2) {
                  Text(resolveAppName(bundleId: app) ?? "未知应用")
                    .font(.caption)
                  Text(app)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                }
                Spacer()
                Button("移除") {
                  draft.collector.excludedApps.removeAll { $0 == app }
                }
                .buttonStyle(.borderless)
              }
            }
          }

          HStack {
            Button("添加当前前台应用") { addFrontmostAppToBlacklist() }
            Menu("从正在运行的应用添加…") {
              let items = runningUserApps()
              if items.isEmpty {
                Text("暂无可选应用")
              } else {
                ForEach(items, id: \.bundleId) { item in
                  Button(item.name) { addExcludedBundleId(item.bundleId) }
                }
              }
            }
          }

          HStack {
            TextField("（高级）输入 Bundle ID，例如 com.google.Chrome", text: $excludedAppInput)
            Button("添加") { addExcludedBundleId(excludedAppInput) }
              .disabled(excludedAppInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          }

          Text("提示：黑名单按应用身份（Bundle ID）生效，更稳定。推荐：切换到要排除的应用 → 点击“添加当前前台应用”。")
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
    // 兼容旧调用点：保留函数名，但语义升级为 Bundle ID。
    addExcludedBundleId(raw)
  }

  private func addFrontmostAppToBlacklist() {
    let app = NSWorkspace.shared.frontmostApplication
    let bundleId = app?.bundleIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if bundleId.isEmpty {
      message = "添加失败：无法识别当前前台应用的 Bundle ID。"
      return
    }
    addExcludedBundleId(bundleId)
  }

  private struct RunningAppItem: Identifiable {
    let bundleId: String
    let name: String
    var id: String { bundleId }
  }

  private func runningUserApps() -> [RunningAppItem] {
    // 展示“用户可见应用”（排除后台 daemon/服务），并按名字排序。
    let apps = NSWorkspace.shared.runningApplications
      .filter { $0.activationPolicy != .prohibited }
      .compactMap { app -> RunningAppItem? in
        guard let bundleId = app.bundleIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines), !bundleId.isEmpty else {
          return nil
        }
        let name = app.localizedName?.trimmingCharacters(in: .whitespacesAndNewlines)
        return RunningAppItem(bundleId: bundleId, name: (name?.isEmpty == false) ? name! : bundleId)
      }

    // 去重：同一个 bundleId 可能有多个进程（helper）。
    var seen: Set<String> = []
    var deduped: [RunningAppItem] = []
    deduped.reserveCapacity(apps.count)
    for item in apps {
      if seen.contains(item.bundleId) { continue }
      seen.insert(item.bundleId)
      deduped.append(item)
    }

    return deduped.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
  }

  private func resolveAppName(bundleId: String) -> String? {
    let trimmed = bundleId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }

    // 1) 优先：正在运行的应用（拿到的名字通常更接近用户认知）
    if let running = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == trimmed }) {
      if let name = running.localizedName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
        return name
      }
    }

    // 2) 其次：从 Bundle 读取显示名（即便未运行也可解析）
    if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: trimmed),
       let bundle = Bundle(url: url)
    {
      let displayName =
        (bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
      if let displayName, !displayName.isEmpty {
        return displayName
      }

      let name =
        (bundle.object(forInfoDictionaryKey: kCFBundleNameKey as String) as? String)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
      if let name, !name.isEmpty {
        return name
      }
    }

    return nil
  }

  private func addExcludedBundleId(_ raw: String) {
    let bundleId = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !bundleId.isEmpty else { return }

    // 轻量校验：Bundle ID 一般是反向域名（包含至少一个 '.'，且不包含空格）。
    if !isLikelyBundleId(bundleId) {
      message = "添加失败：黑名单现在按应用身份（Bundle ID）生效。请使用“添加当前前台应用”。"
      return
    }

    if !draft.collector.excludedApps.contains(bundleId) {
      draft.collector.excludedApps.append(bundleId)
      draft.collector.excludedApps.sort()
    }
    excludedAppInput = ""
  }

  private func isLikelyBundleId(_ value: String) -> Bool {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return false }
    if trimmed.contains(where: { $0.isWhitespace }) { return false }
    if !trimmed.contains(".") { return false }

    // 允许：字母/数字/点/下划线/连字符（对常见 Bundle ID 足够）
    let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
    return trimmed.unicodeScalars.allSatisfy { allowed.contains($0) }
  }
}

private struct PermissionStatusView: View {
  let granted: Bool?
  let missingText: String

  var body: some View {
    switch granted {
    case .some(true):
      Label("已授权", systemImage: "checkmark.circle.fill")
        .foregroundStyle(.green)
        .font(.caption)
    case .some(false):
      Label(missingText, systemImage: "exclamationmark.triangle.fill")
        .foregroundStyle(.red)
        .font(.caption)
    case .none:
      Label("未检查", systemImage: "questionmark.circle")
        .foregroundStyle(.secondary)
        .font(.caption)
    }
  }
}
