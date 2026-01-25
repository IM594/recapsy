import AppKit
import SwiftUI

struct MenuBarView: View {
  @EnvironmentObject var supervisor: Supervisor

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("RecapSense")
        .font(.headline)

      VStack(alignment: .leading, spacing: 6) {
        StatusRow(name: "Agent", state: supervisor.agent.state)
        StatusRow(name: "MCP（SSE）", state: supervisor.mcp.state)
        StatusRow(name: "Collector", state: supervisor.collector.state)
      }

      Divider()

      Button("打开主窗口") {
        MainWindowController.shared.show(supervisor: supervisor)
      }

      Divider()

      Toggle(
        "Agent",
        isOn: Binding(
          get: { supervisor.agentEnabled },
          set: { on in on ? supervisor.startAgent() : supervisor.stopAgent() }
        )
      )

      Toggle(
        "MCP（SSE）",
        isOn: Binding(
          get: { supervisor.mcp.state.isRunning },
          set: { on in on ? supervisor.startMcpSse() : supervisor.stopMcpSse() }
        )
      )

      Toggle(
        "采集（Collector）",
        isOn: Binding(
          get: { supervisor.collectorEnabled },
          set: { on in
            if on {
              supervisor.resumeCollector()
            } else {
              // 关闭开关：视为“彻底停止”，不做自动恢复。
              supervisor.stopCollectorFully()
            }
          }
        )
      )

      if supervisor.collectorPauseState.isPaused {
        Text("采集状态：\(supervisor.collectorPauseState.label)")
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      if supervisor.collectorEnabled && !supervisor.collectorPauseState.isPaused {
        if supervisor.collectorPermissionDiagnostics.checking {
          Text("正在检查采集器权限…")
            .font(.caption)
            .foregroundStyle(.secondary)
        } else if supervisor.collectorPermissionDiagnostics.isScreenRecordingMissing {
          Label("未授权“屏幕录制”，无法采集", systemImage: "exclamationmark.triangle.fill")
            .font(.caption)
            .foregroundStyle(.red)
          Button("打开系统设置：屏幕录制") { PrivacyPane.openScreenCapture() }
        } else if supervisor.collectorPermissionDiagnostics.isAccessibilityMissing {
          Label("未授权“辅助功能”，标题可能不准确", systemImage: "exclamationmark.triangle.fill")
            .font(.caption)
            .foregroundStyle(.secondary)
          Button("打开系统设置：辅助功能") { PrivacyPane.openAccessibility() }
        }
      }

      let shouldShowAgentAutoRecoverHint: Bool = {
        if !supervisor.agentEnabled { return false }
        switch supervisor.agent.state {
        case .starting, .running, .runningExternal:
          return false
        case .stopped, .exited, .failed:
          return true
        }
      }()

      if shouldShowAgentAutoRecoverHint {
        Text(
          supervisor.agentDiagnostics.autoRestarting
            ? "Agent 异常，正在自动恢复…"
            : "Agent 已停止，将自动恢复…"
        )
        .font(.caption)
        .foregroundStyle(.secondary)
      }

      let shouldShowAutoRecoverHint: Bool = {
        if !supervisor.collectorEnabled { return false }
        if supervisor.collectorPauseState.isPaused { return false }
        switch supervisor.collector.state {
        case .starting, .running, .runningExternal:
          return false
        case .stopped, .exited, .failed:
          return true
        }
      }()

      if shouldShowAutoRecoverHint {
        Text(
          supervisor.collectorDiagnostics.autoRestarting
            ? "采集器异常，正在自动恢复…"
            : "采集器已停止，将自动恢复…"
        )
        .font(.caption)
        .foregroundStyle(.secondary)
      }

      Menu("暂停采集…") {
        Button("暂停 15 分钟") { supervisor.pauseCollector(forSeconds: 15 * 60) }
        Button("暂停 1 小时") { supervisor.pauseCollector(forSeconds: 60 * 60) }
        Divider()
        Button("暂停直到手动恢复") { supervisor.pauseCollectorManually() }
        if supervisor.collectorPauseState.isPaused {
          Divider()
          Button("恢复采集") { supervisor.resumeCollector() }
        }
      }

      let excludedLabel = supervisor.lastFrontmostApp?.displayName ?? "—"
      Button("排除当前应用 — \(excludedLabel)") {
        supervisor.excludeCurrentFrontmostAppFromCollection()
      }
      .disabled((supervisor.lastFrontmostApp?.bundleId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "").isEmpty)

      Divider()

      Button("退出并停止全部") {
        MainWindowController.shared.prepareForTermination()
        NSApp.terminate(nil)
      }
    }
    .padding(12)
    .onAppear {
      supervisor.checkCollectorPermissionsNow()
    }
  }
}

private struct StatusRow: View {
  let name: String
  let state: ManagedProcessState

  var body: some View {
    HStack(spacing: 6) {
      Circle()
        .fill(color)
        .frame(width: 8, height: 8)
      Text("\(name)：\(label)")
        .font(.caption)
        .foregroundStyle(.secondary)
    }
  }

  private var color: Color {
    switch state {
    case .running, .runningExternal:
      return .green
    case .starting:
      return .yellow
    case .stopped:
      return .gray
    case .exited, .failed:
      return .red
    }
  }

  private var label: String {
    switch state {
    case .stopped:
      return "已停止"
    case .starting:
      return "启动中"
    case .running(let pid):
      return "运行中（pid \(pid)）"
    case .runningExternal:
      return "运行中（外部进程）"
    case .exited(let code):
      return "已退出（code \(code)）"
    case .failed(let message):
      return "失败（\(message)）"
    }
  }
}
