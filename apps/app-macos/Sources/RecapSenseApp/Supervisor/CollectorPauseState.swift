import Foundation

/// Collector 的暂停状态（仅 UI 本地控制，第一版不落库）。
///
/// 说明：
/// - 我们用“暂停”而不是“停止”的语义，是为了支持定时恢复（例如暂停 15 分钟）。
/// - 当前实现等价于：暂停 = 停止 collector 进程；恢复 = 重新启动 collector 进程。
enum CollectorPauseState: Equatable {
  case none
  case manual
  case until(Date)

  var isPaused: Bool {
    switch self {
    case .none:
      return false
    case .manual, .until:
      return true
    }
  }

  var label: String {
    switch self {
    case .none:
      return "未暂停"
    case .manual:
      return "已暂停（手动）"
    case .until(let date):
      return "已暂停（到 \(formatTime(date))）"
    }
  }
}

private func formatTime(_ date: Date) -> String {
  let f = DateFormatter()
  f.locale = Locale(identifier: "zh_CN")
  f.timeZone = TimeZone.current
  f.dateFormat = "HH:mm"
  return f.string(from: date)
}

