import Foundation

public final class FallbackFrameSource: FrameSource {
    private let primary: FrameSource
    private let fallback: FrameSource
    private let fallbackOnNil: Bool
    private let onPrimaryFailure: (Error) -> Void

    public init(
        primary: FrameSource,
        fallback: FrameSource,
        fallbackOnNil: Bool = true,
        onPrimaryFailure: @escaping (Error) -> Void = { _ in }
    ) {
        self.primary = primary
        self.fallback = fallback
        self.fallbackOnNil = fallbackOnNil
        self.onPrimaryFailure = onPrimaryFailure
    }

    public func captureFrame(at date: Date) throws -> CapturedFrame? {
        do {
            let frame = try primary.captureFrame(at: date)
            if frame != nil || !fallbackOnNil {
                return frame
            }
        } catch {
            onPrimaryFailure(error)
        }

        return try fallback.captureFrame(at: date)
    }
}
