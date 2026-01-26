import AppKit
import SwiftUI

struct MenuBarView: View {
  @EnvironmentObject var supervisor: Supervisor

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("RecapSense")
        .font(.caption)
        .foregroundStyle(.secondary)

      Button("打开 RecapSense") {
        MainWindowController.shared.show(supervisor: supervisor)
      }

      Menu("暂停采集上下文") {
        if !supervisor.collectorEnabled {
          Text("采集已关闭")
            .font(.caption)
            .foregroundStyle(.secondary)
          Button("开启采集") { supervisor.resumeCollector() }
        } else {
          if supervisor.collectorPauseState.isPaused {
            Text("当前：\(supervisor.collectorPauseState.label)")
              .font(.caption)
              .foregroundStyle(.secondary)
            Divider()
            Button("恢复采集") { supervisor.resumeCollector() }
            Divider()
          }

          Button("暂停 15 分钟") { supervisor.pauseCollector(forSeconds: 15 * 60) }
          Button("暂停 1 小时") { supervisor.pauseCollector(forSeconds: 60 * 60) }
          Divider()
          Button("暂停直到手动恢复") { supervisor.pauseCollectorManually() }
        }
      }

      Divider()

      let excludedLabel = supervisor.exclusionTargetApp?.displayName ?? "—"
      Button("排除当前应用 — \(excludedLabel)") {
        supervisor.excludeCurrentFrontmostAppFromCollection()
      }
      .disabled((supervisor.exclusionTargetApp?.bundleId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "").isEmpty)

      Divider()

      let statusMessage: String? = {
        if !supervisor.collectorEnabled {
          return "采集：已关闭"
        }

        if supervisor.collectorPauseState.isPaused {
          return "采集：\(supervisor.collectorPauseState.label)"
        }

        if supervisor.collectorDiagnostics.autoRestarting {
          return "采集器异常，正在自动恢复…"
        }

        switch supervisor.collector.state {
        case .starting:
          return "采集：启动中…"
        case .running, .runningExternal:
          return "采集：运行中"
        case .stopped, .exited, .failed:
          return "采集器已停止，将自动恢复…"
        }
      }()

      if let statusMessage {
        Text(statusMessage)
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      Button("退出 RecapSense（停止采集）") {
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
