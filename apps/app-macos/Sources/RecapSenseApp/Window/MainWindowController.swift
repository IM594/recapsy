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

  func show(supervisor: Supervisor) {
    if let window {
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

  func windowWillClose(_ notification: Notification) {
    // 用户点红灯关闭后，释放引用；下次 show() 会重新创建。
    window = nil
  }
}

