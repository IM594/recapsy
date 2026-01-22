import AppKit
import SwiftUI

/// 手动管理“主窗口”，用于：
/// - 保证单实例（不会点一次开一个新窗口）
/// - 支持 Dock 图标点击时重新打开窗口
/// - 让菜单栏应用拥有更接近“正常桌面 App”的窗口行为
@MainActor
final class MainWindowController: NSObject, NSWindowDelegate {
  static let shared = MainWindowController()

  private var window: NSWindow? = nil
  private var allowCloseForTermination = false

  func show(supervisor: Supervisor) {
    if let window {
      if window.isMiniaturized {
        window.deminiaturize(nil)
      }
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
      return
    }

    let rootView = MainWindowView()
      .environmentObject(supervisor)

    let hosting = NSHostingView(rootView: rootView)

    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 860, height: 620),
      styleMask: [.titled, .closable, .resizable, .miniaturizable],
      backing: .buffered,
      defer: false
    )
    window.title = "RecapSense"
    window.center()
    window.contentView = hosting
    window.isReleasedWhenClosed = false
    window.delegate = self

    self.window = window
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  func prepareForTermination() {
    // 退出应用时允许窗口真正关闭（不再拦截）。
    allowCloseForTermination = true
  }

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    // 关键行为：
    // - 红灯关闭（或 Cmd-W）不应销毁主窗口，否则 SwiftUI 的 Tab/滚动/筛选等状态会全部丢失；
    // - 更符合 macOS 直觉的是“关闭=隐藏”，再次打开时保留上次位置与状态。
    if allowCloseForTermination {
      return true
    }
    sender.orderOut(nil)
    return false
  }
}
