import Foundation

/// 用于把 SwiftUI App 内的对象暴露给 AppKit（例如 Dock 点击回调）。
///
/// 说明：这是一段“过渡期”桥接代码。等我们把发布形态（.app/DMG）与更完整的窗口管理做完后，
/// 可以再收敛/重构这层。
@MainActor
final class RecapSenseAppContext {
  static let shared = RecapSenseAppContext()

  var supervisor: Supervisor? = nil

  // 保持强引用，否则锁对象会被释放，文件锁也会随之失效。
  var instanceLock: SingleInstanceLock? = nil

  // 启动期错误（例如重复启动导致锁占用），用于弹窗提示。
  var startupErrorMessage: String? = nil
}
