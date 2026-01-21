import AppKit
import SwiftUI

@main
struct RecapSenseAppMain: App {
  @StateObject private var supervisor = Supervisor()

  init() {
    // 我们希望这是一个“有主窗口”的桌面应用（后续会承载搜索/日志/聊天），
    // 所以需要在 Dock 与 Cmd-Tab 里可见（MenuBarExtra 默认更像“菜单栏小组件”）。
    NSApplication.shared.setActivationPolicy(.regular)
  }

  var body: some Scene {
    MenuBarExtra("RecapSense", systemImage: "brain") {
      MenuBarView()
        .environmentObject(supervisor)
    }

    // 使用 Window（单实例），避免用户在菜单栏里重复点击后弹出多个主窗口。
    Window("RecapSense", id: "main") {
      MainWindowView()
        .environmentObject(supervisor)
    }
  }
}
