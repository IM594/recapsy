import AppKit
import Foundation

enum PrivacyPane {
  static func openScreenCapture() {
    open(anchor: "Privacy_ScreenCapture")
  }

  static func openAccessibility() {
    open(anchor: "Privacy_Accessibility")
  }

  private static func open(anchor: String) {
    guard
      let url = URL(
        string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)"
      )
    else {
      return
    }
    NSWorkspace.shared.open(url)
  }
}

