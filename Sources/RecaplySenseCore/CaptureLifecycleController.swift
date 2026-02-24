import Foundation

public enum CaptureLifecycleState: Sendable {
    case stopped
    case running
    case paused
}

public protocol CaptureServiceControlling: AnyObject {
    func start(interval: TimeInterval)
    func stop()
    func stopAndFlush() throws
}

extension CaptureService: CaptureServiceControlling {}

public final class CaptureLifecycleController {
    private let captureService: CaptureServiceControlling
    private let captureInterval: TimeInterval

    public private(set) var state: CaptureLifecycleState = .stopped

    public init(captureService: CaptureServiceControlling, captureInterval: TimeInterval) {
        self.captureService = captureService
        self.captureInterval = captureInterval
    }

    public func start() {
        guard state == .stopped else {
            return
        }

        captureService.start(interval: captureInterval)
        state = .running
    }

    public func pause() {
        guard state == .running else {
            return
        }

        captureService.stop()
        state = .paused
    }

    public func resume() {
        guard state == .paused else {
            return
        }

        captureService.start(interval: captureInterval)
        state = .running
    }

    public func stop() throws {
        guard state != .stopped else {
            return
        }

        try captureService.stopAndFlush()
        state = .stopped
    }
}
