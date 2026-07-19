import Foundation

/// Synchronizes one asynchronous capture attempt with the serial capture
/// worker. A timeout only reports that the attempt has not finished; it never
/// turns a late completion into the result of a later attempt.
public final class CaptureAsyncResultGate<Value>: @unchecked Sendable {
    private enum State {
        case pending
        case finished(Value)
    }

    private let condition = NSCondition()
    private var state: State = .pending

    public init() {}

    /// Records the first terminal value and ignores any duplicate completion.
    public func complete(_ value: Value) {
        condition.lock()
        defer { condition.unlock() }
        guard case .pending = state else {
            return
        }
        state = .finished(value)
        condition.broadcast()
    }

    /// Returns nil only when the deadline elapsed before the attempt finished.
    public func wait(until deadline: Date) -> Value? {
        condition.lock()
        defer { condition.unlock() }

        while case .pending = state {
            if !condition.wait(until: deadline) {
                guard case .pending = state else {
                    break
                }
                return nil
            }
        }
        guard case let .finished(value) = state else {
            return nil
        }
        return value
    }

    /// Keeps the owning capture worker occupied until its underlying operation
    /// has actually ended, preventing a timed-out system capture from
    /// overlapping the next capture tick.
    public func waitUntilFinished() -> Value {
        condition.lock()
        defer { condition.unlock() }

        while case .pending = state {
            condition.wait()
        }
        guard case let .finished(value) = state else {
            preconditionFailure("Capture result gate finished without a value.")
        }
        return value
    }
}
