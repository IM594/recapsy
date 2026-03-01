import Foundation
#if os(macOS)
import AppKit
import ApplicationServices
#endif

#if os(macOS)
public protocol CGWindowCaptureEnvironment {
    func frontmostApplicationName() -> String?
    func windowList() -> [[String: Any]]?
    func captureWindowImage(windowID: CGWindowID) -> CGImage?
}

private struct LiveCGWindowCaptureEnvironment: CGWindowCaptureEnvironment {
    func frontmostApplicationName() -> String? {
        NSWorkspace.shared.frontmostApplication?.localizedName
    }

    func windowList() -> [[String: Any]]? {
        CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]]
    }

    func captureWindowImage(windowID: CGWindowID) -> CGImage? {
        CGWindowListCreateImage(
            .null,
            .optionIncludingWindow,
            windowID,
            [.boundsIgnoreFraming, .bestResolution]
        )
    }
}

public final class CGWindowCaptureSource: FrameSource {
    private let environment: any CGWindowCaptureEnvironment
    private let artifactWriter: any FrameArtifactWriting

    public init(mediaDirectory: URL) throws {
        self.environment = LiveCGWindowCaptureEnvironment()
        self.artifactWriter = try FrameArtifactWriter(mediaDirectory: mediaDirectory)
    }

    init(environment: any CGWindowCaptureEnvironment, artifactWriter: any FrameArtifactWriting) {
        self.environment = environment
        self.artifactWriter = artifactWriter
    }

    public func captureFrame(at date: Date) throws -> CapturedFrame? {
        guard let frontmostWindow = findFrontmostWindow() else {
            return nil
        }

        guard let image = environment.captureWindowImage(windowID: frontmostWindow.windowID) else {
            return nil
        }

        let filename = "frame-\(Int(date.timeIntervalSince1970 * 1000))-\(frontmostWindow.windowID).png"
        let artifact = try artifactWriter.write(cgImage: image, filename: filename)

        return CapturedFrame(
            capturedAt: date,
            appName: frontmostWindow.appName,
            windowTitle: frontmostWindow.windowTitle,
            contentHash: artifact.hash,
            rawPayload: artifact.path,
            mockedText: "",
            imagePath: artifact.path
        )
    }

    private func findFrontmostWindow() -> WindowInfo? {
        guard let ownerName = environment.frontmostApplicationName() else {
            return nil
        }

        guard let windowList = environment.windowList() else {
            return nil
        }

        for window in windowList {
            let layer = (window[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
            guard layer == 0 else {
                continue
            }

            guard let currentOwner = window[kCGWindowOwnerName as String] as? String,
                  currentOwner == ownerName else {
                continue
            }

            guard let number = window[kCGWindowNumber as String] as? NSNumber else {
                continue
            }

            let name = (window[kCGWindowName as String] as? String)
                .flatMap { $0.isEmpty ? nil : $0 } ?? ownerName

            return WindowInfo(
                windowID: CGWindowID(number.uint32Value),
                appName: ownerName,
                windowTitle: name
            )
        }

        return nil
    }
}

private struct WindowInfo {
    let windowID: CGWindowID
    let appName: String
    let windowTitle: String
}
#else
public final class CGWindowCaptureSource: FrameSource {
    public init(mediaDirectory: URL) throws {
        _ = mediaDirectory
    }

    public func captureFrame(at date: Date) throws -> CapturedFrame? {
        _ = date
        return nil
    }
}
#endif
