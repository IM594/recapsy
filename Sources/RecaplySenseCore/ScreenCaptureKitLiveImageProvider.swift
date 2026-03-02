import Foundation
#if os(macOS)
import AppKit
#endif
#if canImport(ScreenCaptureKit)
import ScreenCaptureKit
#endif

#if os(macOS) && canImport(ScreenCaptureKit)
enum ScreenCaptureKitLiveImageProvider {
    static func captureImage() throws -> CGImage {
        guard #available(macOS 14.0, *) else {
            throw RecaplySenseError.capture(message: "ScreenCaptureKit requires macOS 14+")
        }
        return try captureImageOnSupportedOS()
    }

    @available(macOS 14.0, *)
    private static func captureImageOnSupportedOS() throws -> CGImage {
        try syncAwaitValue {
            let content = try await SCShareableContent.current
            guard let display = content.displays.first else {
                throw RecaplySenseError.capture(message: "No display available for ScreenCaptureKit")
            }

            let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
            let config = SCStreamConfiguration()
            config.width = display.width
            config.height = display.height

            return try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: config
            )
        }
    }
}
#endif

func syncAwaitValue<T>(_ operation: @escaping @Sendable () async throws -> T) throws -> T {
    let semaphore = DispatchSemaphore(value: 0)
    let state = LockedResult<T>()

    Task {
        do {
            let value = try await operation()
            state.set(.success(value))
        } catch {
            state.set(.failure(error))
        }
        semaphore.signal()
    }

    semaphore.wait()
    return try state.get().get()
}

final class LockedResult<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<T, Error>?

    func set(_ result: Result<T, Error>) {
        lock.lock()
        self.result = result
        lock.unlock()
    }

    func get() -> Result<T, Error> {
        lock.lock()
        defer { lock.unlock() }
        return result ?? .failure(RecaplySenseError.capture(message: "await result is empty"))
    }
}
