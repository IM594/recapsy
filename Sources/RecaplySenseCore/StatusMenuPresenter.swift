import Foundation

public enum StatusMenuAction: Sendable, Equatable {
    case openMain
    case start
    case pause
    case resume
    case stop
    case openDataDirectory
    case quit
}

public enum StatusMenuEntry: Sendable, Equatable {
    case separator
    case item(title: String, action: StatusMenuAction, keyEquivalent: String)
}

public struct StatusMenuPresenter {
    public init() {}

    public func makeEntries(
        lifecycleState: CaptureLifecycleState?,
        hasDataDirectory: Bool
    ) -> [StatusMenuEntry] {
        var entries: [StatusMenuEntry] = [
            .item(title: "打开 RecaplySense", action: .openMain, keyEquivalent: ""),
            .separator,
        ]

        switch lifecycleState {
        case .running:
            entries.append(.item(title: "暂停采集", action: .pause, keyEquivalent: ""))
            entries.append(.item(title: "停止采集", action: .stop, keyEquivalent: ""))
        case .paused:
            entries.append(.item(title: "继续采集", action: .resume, keyEquivalent: ""))
            entries.append(.item(title: "停止采集", action: .stop, keyEquivalent: ""))
        case .stopped, .none:
            entries.append(.item(title: "开始采集", action: .start, keyEquivalent: ""))
        }

        if hasDataDirectory {
            entries.append(.item(title: "打开数据目录", action: .openDataDirectory, keyEquivalent: ""))
        }

        entries.append(.separator)
        entries.append(.item(title: "退出 RecaplySense", action: .quit, keyEquivalent: "q"))
        return entries
    }
}
