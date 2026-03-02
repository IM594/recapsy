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
        self.imageProvider = Self.makeLiveImageProvider()
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

    static func makeLiveImageProvider() -> () throws -> CGImage {
        {
            try ScreenCaptureKitLiveImageProvider.captureImage()
        }
    }

    public func captureFrame(at date: Date) throws -> CapturedFrame? {
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
