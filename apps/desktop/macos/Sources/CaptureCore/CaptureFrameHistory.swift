/// Session-scoped duplicate-frame state. A policy activation, pause, or resume
/// starts a distinct capture session, so a frame accepted by an earlier session
/// must never suppress the first frame of the new one.
public struct CaptureFrameHistory: Equatable, Sendable {
    public private(set) var previousAccepted: CaptureFrameFingerprint?

    public init(previousAccepted: CaptureFrameFingerprint? = nil) {
        self.previousAccepted = previousAccepted
    }

    public mutating func recordAccepted(_ fingerprint: CaptureFrameFingerprint) {
        previousAccepted = fingerprint
    }

    public mutating func resetForNewSession() {
        previousAccepted = nil
    }
}
