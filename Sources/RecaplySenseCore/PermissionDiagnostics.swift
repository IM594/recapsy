import Foundation

public enum AppPermission: CaseIterable, Hashable, Sendable {
    case screenRecording
    case microphone
    case accessibility
}

public enum PermissionStatus: Sendable {
    case granted
    case denied
    case notDetermined
}

public struct PermissionSnapshot: Sendable {
    public let statusByPermission: [AppPermission: PermissionStatus]

    public init(statusByPermission: [AppPermission: PermissionStatus]) {
        self.statusByPermission = statusByPermission
    }

    public var hasBlockingPermission: Bool {
        statusByPermission.values.contains { status in
            switch status {
            case .granted:
                return false
            case .denied, .notDetermined:
                return true
            }
        }
    }
}

public struct PermissionDiagnostics {
    public typealias Checker = (AppPermission) -> PermissionStatus

    private let checker: Checker

    public init(checker: @escaping Checker) {
        self.checker = checker
    }

    public func snapshot() -> PermissionSnapshot {
        var statusByPermission: [AppPermission: PermissionStatus] = [:]
        for permission in AppPermission.allCases {
            statusByPermission[permission] = checker(permission)
        }

        return PermissionSnapshot(statusByPermission: statusByPermission)
    }
}
