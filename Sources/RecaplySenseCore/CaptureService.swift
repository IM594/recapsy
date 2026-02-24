import Foundation

public protocol FrameSource: AnyObject {
    func captureFrame(at date: Date) throws -> CapturedFrame?
}

public final class CaptureService {
    private let frameSource: FrameSource
    private let pipeline: OfflinePipeline
    private let now: () -> Date
    private let onError: (Error) -> Void

    private let queue = DispatchQueue(label: "com.recaply.sense.capture-service")
    private var timer: DispatchSourceTimer?

    public init(
        frameSource: FrameSource,
        pipeline: OfflinePipeline,
        now: @escaping () -> Date = Date.init,
        onError: @escaping (Error) -> Void = { _ in }
    ) {
        self.frameSource = frameSource
        self.pipeline = pipeline
        self.now = now
        self.onError = onError
    }

    @discardableResult
    public func captureOnce() throws -> Bool {
        guard let frame = try frameSource.captureFrame(at: now()) else {
            return false
        }
        try pipeline.ingest(frame: frame)
        return true
    }

    public func start(interval: TimeInterval) {
        stop()

        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: interval)
        timer.setEventHandler { [weak self] in
            guard let self else {
                return
            }
            do {
                _ = try self.captureOnce()
            } catch {
                self.onError(error)
            }
        }
        self.timer = timer
        timer.resume()
    }

    public func stop() {
        timer?.cancel()
        timer = nil
    }

    public func stopAndFlush() throws {
        stop()
        try pipeline.flush()
    }
}
