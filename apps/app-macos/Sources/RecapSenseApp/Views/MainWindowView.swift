import SwiftUI

struct MainWindowView: View {
  @EnvironmentObject var supervisor: Supervisor

  var body: some View {
    VStack(spacing: 0) {
      let shouldShowAgentBanner: Bool = {
        if !supervisor.agentEnabled { return false }
        switch supervisor.agent.state {
        case .starting, .running, .runningExternal:
          return false
        case .stopped, .exited, .failed:
          return true
        }
      }()

      if shouldShowAgentBanner {
        PermissionBannerView(
          title: supervisor.agentDiagnostics.autoRestarting ? "后端异常，正在自动恢复…" : "后端已停止",
          message: "RecapSense 需要后端服务（Agent）来存储与搜索内容。如果长时间无法恢复，可以点击下方按钮重启。",
          buttonTitle: "重启后端",
          action: { supervisor.startAgent() }
        )
      }

      if supervisor.collectorEnabled,
         supervisor.collectorPauseState == .none,
         supervisor.collectorPermissionDiagnostics.isScreenRecordingMissing
      {
        PermissionBannerView(
          title: "需要授权：屏幕录制",
          message: "RecapSense 需要“屏幕录制”权限才能采集屏幕内容。",
          buttonTitle: "打开系统设置",
          action: { PrivacyPane.openScreenCapture() }
        )
      }

      TabView {
        SearchView()
          .tabItem { Label("搜索", systemImage: "magnifyingglass") }

        DailySummaryView()
          .tabItem { Label("日总结", systemImage: "calendar") }

        LogsView()
          .tabItem { Label("日志", systemImage: "doc.text") }

        SettingsView()
          .tabItem { Label("设置", systemImage: "gearshape") }

        ChatPlaceholderView()
          .tabItem { Label("聊天（占位）", systemImage: "bubble.left.and.bubble.right") }
      }
    }
    .frame(minWidth: 760, minHeight: 520)
    .onAppear {
      supervisor.checkCollectorPermissionsNow()
    }
  }
}

private struct PermissionBannerView: View {
  let title: String
  let message: String
  let buttonTitle: String
  let action: () -> Void

  var body: some View {
    HStack(alignment: .center, spacing: 10) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(.orange)
        .accessibilityHidden(true)

      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.subheadline)
          .fontWeight(.semibold)
        Text(message)
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      Spacer()

      Button(buttonTitle, action: action)
    }
    .padding(12)
    .background(Color.orange.opacity(0.10))
    .overlay(
      RoundedRectangle(cornerRadius: 8)
        .stroke(Color.orange.opacity(0.20), lineWidth: 1)
    )
    .padding(.horizontal, 12)
    .padding(.top, 12)
  }
}
