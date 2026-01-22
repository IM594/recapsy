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

    // 开发期：SwiftPM 可执行程序可能会被重复启动多次，导致端口占用与状态错乱。
    // 用一个文件锁做“单实例”保护；失败时给出明确提示并阻止自动启动服务。
    let cfg = SupervisorConfig.loadFromEnvironment()
    let lockFile = cfg.dataDir.appendingPathComponent("run/recapsense-app.lock")
    do {
      RecapSenseAppContext.shared.instanceLock = try SingleInstanceLock(lockFile: lockFile)
    } catch {
      RecapSenseAppContext.shared.startupErrorMessage = String(describing: error)
    }

    // 让 AppKit 回调（Dock 点击等）能访问到同一个 Supervisor。
    let shouldAutoStart = (RecapSenseAppContext.shared.startupErrorMessage == nil)
    let sup = Supervisor(autoStart: shouldAutoStart)
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
