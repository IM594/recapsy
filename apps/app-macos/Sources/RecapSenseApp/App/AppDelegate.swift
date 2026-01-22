import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    // 开发期（SwiftPM 可执行程序）没有 app bundle 的图标资源，所以 Dock 上会显示“黑色 exec”。
    // 这里用一个 SF Symbol 做一个临时 icon，让体验不那么“命令行感”。
    if let icon = NSImage(systemSymbolName: "brain", accessibilityDescription: "RecapSense") {
      NSApp.applicationIconImage = icon
      let view = NSImageView(image: icon)
      view.imageScaling = .scaleProportionallyUpOrDown
      NSApp.dockTile.contentView = view
      NSApp.dockTile.display()
    }

    // 启动期错误（例如重复启动）：给出弹窗提示，避免用户以为“怎么没反应/怎么端口占用”。
    if let message = RecapSenseAppContext.shared.startupErrorMessage {
      let alert = NSAlert()
      alert.messageText = "RecapSense 已在运行"
      alert.informativeText = message
      alert.alertStyle = .warning
      alert.addButton(withTitle: "退出")
      alert.runModal()
      NSApp.terminate(nil)
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

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    // 如果是“重复启动”的提示弹窗触发退出，不需要做 stopAll（也没有子进程是当前实例启动的）。
    if RecapSenseAppContext.shared.startupErrorMessage != nil {
      return .terminateNow
    }

    // 关键：优雅退出并等待子进程停止，避免 Agent/MCP 端口残留导致下次启动 `EADDRINUSE`。
    Task { @MainActor in
      await RecapSenseAppContext.shared.supervisor?.stopAllAndWait()
      sender.reply(toApplicationShouldTerminate: true)
    }
    return .terminateLater
  }
}
