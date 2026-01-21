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
          get: { supervisor.agent.state.isRunning },
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
          get: { supervisor.collector.state.isRunning },
          set: { on in on ? supervisor.startCollector() : supervisor.stopCollector() }
        )
      )

      Divider()

      Button("退出并停止全部") {
        supervisor.stopAll()
        NSApp.terminate(nil)
      }
    }
    .padding(12)
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
    case .running:
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
    case .exited(let code):
      return "已退出（code \(code)）"
    case .failed(let message):
      return "失败（\(message)）"
    }
  }
}
