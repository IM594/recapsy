import Foundation

public enum CaptureAction: Sendable {
    case start
    case pause
    case resume
    case stop
}

public enum CaptureOperation: Sendable, Equatable {
    case start
    case pause
    case resume
    case stop
}

public struct CaptureActionResolution: Sendable, Equatable {
    public let operation: CaptureOperation?
    public let shouldRequestScreenPermission: Bool
    public let errorMessage: String?

    public init(
        operation: CaptureOperation?,
        shouldRequestScreenPermission: Bool,
        errorMessage: String?
    ) {
        self.operation = operation
        self.shouldRequestScreenPermission = shouldRequestScreenPermission
        self.errorMessage = errorMessage
    }
}

public struct CaptureActionGuard {
    private static let screenPermissionMessage = "缺少 screen 权限，已触发系统授权弹窗；授权后请重启应用。"

    public init() {}

    public func resolve(
        action: CaptureAction,
        lifecycleState: CaptureLifecycleState?,
        hasScreenPermission: Bool
    ) -> CaptureActionResolution {
        switch action {
        case .start:
            return resolveStart(lifecycleState: lifecycleState, hasScreenPermission: hasScreenPermission)
        case .pause:
            return CaptureActionResolution(
                operation: lifecycleState == .running ? .pause : nil,
                shouldRequestScreenPermission: false,
                errorMessage: nil
            )
        case .resume:
            return CaptureActionResolution(
                operation: lifecycleState == .paused ? .resume : nil,
                shouldRequestScreenPermission: false,
                errorMessage: nil
            )
        case .stop:
            let canStop = lifecycleState == .running || lifecycleState == .paused
            return CaptureActionResolution(
                operation: canStop ? .stop : nil,
                shouldRequestScreenPermission: false,
                errorMessage: nil
            )
        }
    }

    private func resolveStart(
        lifecycleState: CaptureLifecycleState?,
        hasScreenPermission: Bool
    ) -> CaptureActionResolution {
        guard hasScreenPermission else {
            return CaptureActionResolution(
                operation: nil,
                shouldRequestScreenPermission: true,
                errorMessage: Self.screenPermissionMessage
            )
        }

        return CaptureActionResolution(
            operation: lifecycleState == .stopped || lifecycleState == nil ? .start : nil,
            shouldRequestScreenPermission: false,
            errorMessage: nil
        )
    }
}
