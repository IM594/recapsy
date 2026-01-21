import AppKit
import SwiftUI

@main
struct RecapSenseAppMain: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @StateObject private var supervisor: Supervisor

  init() {
    // 我们希望这是一个“有主窗口”的桌面应用（后续会承载搜索/日志/聊天），
    // 所以需要在 Dock 与 Cmd-Tab 里可见（MenuBarExtra 默认更像“菜单栏小组件”）。
    NSApplication.shared.setActivationPolicy(.regular)

    // 让 AppKit 回调（Dock 点击等）能访问到同一个 Supervisor。
    let sup = Supervisor()
    _supervisor = StateObject(wrappedValue: sup)
    RecapSenseAppContext.shared.supervisor = sup
  }

  var body: some Scene {
    MenuBarExtra("RecapSense", systemImage: "brain") {
      MenuBarView()
        .environmentObject(supervisor)
    }
  }
}
