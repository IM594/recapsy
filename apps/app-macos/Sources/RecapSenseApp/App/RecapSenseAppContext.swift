import Foundation

/// 用于把 SwiftUI App 内的对象暴露给 AppKit（例如 Dock 点击回调）。
///
/// 说明：这是一段“过渡期”桥接代码。等我们把发布形态（.app/DMG）与更完整的窗口管理做完后，
/// 可以再收敛/重构这层。
@MainActor
final class RecapSenseAppContext {
  static let shared = RecapSenseAppContext()

  var supervisor: Supervisor? = nil
}

