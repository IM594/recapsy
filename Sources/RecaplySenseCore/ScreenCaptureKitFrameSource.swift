import Foundation
#if os(macOS)
import AppKit
#endif
#if canImport(ScreenCaptureKit)
import ScreenCaptureKit
#endif

#if os(macOS) && canImport(ScreenCaptureKit)
public final class ScreenCaptureKitFrameSource: FrameSource {
    private let artifactWriter: any FrameArtifactWriting
    private let appNameProvider: () -> String?
    private let imageProvider: () throws -> CGImage

    public init(mediaDirectory: URL) throws {
        self.artifactWriter = try FrameArtifactWriter(mediaDirectory: mediaDirectory)
        self.appNameProvider = {
            NSWorkspace.shared.frontmostApplication?.localizedName
        }
        self.imageProvider = {
            guard #available(macOS 14.0, *) else {
                throw RecaplySenseError.capture(message: "ScreenCaptureKit requires macOS 14+")
            }
            return try ScreenCaptureKitFrameSource.captureImageOnSupportedOS()
        }
    }

    init(
        artifactWriter: any FrameArtifactWriting,
        appNameProvider: @escaping () -> String?,
        imageProvider: @escaping () throws -> CGImage
    ) {
        self.artifactWriter = artifactWriter
        self.appNameProvider = appNameProvider
        self.imageProvider = imageProvider
    }

    public func captureFrame(at date: Date) throws -> CapturedFrame? {
        guard #available(macOS 14.0, *) else {
            throw RecaplySenseError.capture(message: "ScreenCaptureKit requires macOS 14+")
        }

        guard let appName = appNameProvider(), !appName.isEmpty else {
            return nil
        }
        let windowTitle = appName
        let image = try imageProvider()

        let filename = "frame-sckit-\(Int(date.timeIntervalSince1970 * 1000)).png"
        let artifact = try artifactWriter.write(cgImage: image, filename: filename)

        return CapturedFrame(
            capturedAt: date,
            appName: appName,
            windowTitle: windowTitle,
            contentHash: artifact.hash,
            rawPayload: artifact.path,
            mockedText: "",
            imagePath: artifact.path
        )
    }

    @available(macOS 14.0, *)
    private static func captureImageOnSupportedOS() throws -> CGImage {
        try awaitValue {
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
