import Foundation
#if os(macOS)
import AppKit
import CryptoKit
#endif
#if canImport(ScreenCaptureKit)
import ScreenCaptureKit
#endif

#if os(macOS) && canImport(ScreenCaptureKit)
public final class ScreenCaptureKitFrameSource: FrameSource {
    private let mediaDirectory: URL

    public init(mediaDirectory: URL) throws {
        self.mediaDirectory = mediaDirectory
        try FileManager.default.createDirectory(at: mediaDirectory, withIntermediateDirectories: true)
    }

    public func captureFrame(at date: Date) throws -> CapturedFrame? {
        guard #available(macOS 14.0, *) else {
            throw RecaplySenseError.capture(message: "ScreenCaptureKit requires macOS 14+")
        }

        return try captureFrameOnSupportedOS(at: date)
    }

    @available(macOS 14.0, *)
    private func captureFrameOnSupportedOS(at date: Date) throws -> CapturedFrame? {
        guard let app = NSWorkspace.shared.frontmostApplication else {
            return nil
        }

        let appName = app.localizedName ?? "Unknown"
        let windowTitle = appName

        let image = try awaitValue {
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

        let filename = "frame-sckit-\(Int(date.timeIntervalSince1970 * 1000)).png"
        let imageURL = mediaDirectory.appendingPathComponent(filename)

        try writePNG(cgImage: image, to: imageURL)
        let imageData = try Data(contentsOf: imageURL)
        let hash = sha256Hex(data: imageData)

        return CapturedFrame(
            capturedAt: date,
            appName: appName,
            windowTitle: windowTitle,
            contentHash: hash,
            rawPayload: imageURL.path,
            mockedText: "",
            imagePath: imageURL.path
        )
    }

    private func writePNG(cgImage: CGImage, to url: URL) throws {
        let bitmap = NSBitmapImageRep(cgImage: cgImage)
        guard let data = bitmap.representation(using: .png, properties: [:]) else {
            throw RecaplySenseError.capture(message: "cannot convert screenshot to PNG")
        }
        try data.write(to: url, options: .atomic)
    }

    private func sha256Hex(data: Data) -> String {
        SHA256.hash(data: data)
            .map { String(format: "%02x", $0) }
            .joined()
    }
}
#else
public final class ScreenCaptureKitFrameSource: FrameSource {
    public init(mediaDirectory: URL) throws {
        _ = mediaDirectory
    }

    public func captureFrame(at date: Date) throws -> CapturedFrame? {
        _ = date
        throw RecaplySenseError.capture(message: "ScreenCaptureKit unavailable")
    }
}
#endif

private func awaitValue<T>(_ operation: @escaping @Sendable () async throws -> T) throws -> T {
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

private final class LockedResult<T>: @unchecked Sendable {
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
