import AppKit
import ApplicationServices

struct AppContext {
  let appName: String?
  let pid: pid_t?
  let windowTitle: String?
}

enum AccessibilityError: Error, CustomStringConvertible {
  case axError(String)

  var description: String {
    switch self {
    case .axError(let message):
      return message
    }
  }
}

@MainActor
func readFrontmostAppContext(log: (String) -> Void) -> AppContext {
  guard let app = NSWorkspace.shared.frontmostApplication else {
    return AppContext(appName: nil, pid: nil, windowTitle: nil)
  }

  let appName = app.localizedName ?? app.bundleIdentifier
  let pid = app.processIdentifier
  let windowTitle = readFocusedWindowTitle(pid: pid, log: log)
  return AppContext(appName: appName, pid: pid, windowTitle: windowTitle)
}

@MainActor
func readFocusedWindowTitle(pid: pid_t, log: (String) -> Void) -> String? {
  let appElement = AXUIElementCreateApplication(pid)

  var focusedWindow: CFTypeRef?
  let focusedErr = AXUIElementCopyAttributeValue(
    appElement,
    kAXFocusedWindowAttribute as CFString,
    &focusedWindow
  )

  guard focusedErr == .success, let focusedWindow else {
    // 常见原因：没有“辅助功能”权限、目标 app 不支持 AX。
    if !AXIsProcessTrusted() || focusedErr == .apiDisabled {
      log("提示：未获取到窗口标题（可能缺少“辅助功能”权限）。可在 系统设置 → 隐私与安全性 → 辅助功能 中给 recapsense-collector 授权。")
    }
    return nil
  }

  var titleValue: CFTypeRef?
  let titleErr = AXUIElementCopyAttributeValue(
    focusedWindow as! AXUIElement,
    kAXTitleAttribute as CFString,
    &titleValue
  )

  guard titleErr == .success else {
    return nil
  }
  return titleValue as? String
}
