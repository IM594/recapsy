import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    // 开发期（SwiftPM 可执行程序）没有 app bundle 的图标资源，所以 Dock 上会显示“黑色 exec”。
    // 这里用一个 SF Symbol 做一个临时 icon，让体验不那么“命令行感”。
    if let icon = NSImage(systemSymbolName: "brain", accessibilityDescription: "RecapSense") {
      NSApp.applicationIconImage = icon
    }
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    // 点击 Dock 图标时，如果主窗口没打开过/已关闭，默认不会自动创建 SwiftUI Window（当前我们用手动窗口管理）。
    // 这里明确把主窗口拉出来。
    if let supervisor = RecapSenseAppContext.shared.supervisor {
      MainWindowController.shared.show(supervisor: supervisor)
    }
    sender.activate(ignoringOtherApps: true)
    return true
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    // 菜单栏应用：关闭最后一个窗口不应退出（采集/服务仍然要常驻）。
    false
  }
}

