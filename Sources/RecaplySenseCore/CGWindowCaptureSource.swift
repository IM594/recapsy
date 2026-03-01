import Foundation
#if os(macOS)
import AppKit
import ApplicationServices
#endif

#if os(macOS)
public final class CGWindowCaptureSource: FrameSource {
    private let artifactWriter: FrameArtifactWriter

    public init(mediaDirectory: URL) throws {
        self.artifactWriter = try FrameArtifactWriter(mediaDirectory: mediaDirectory)
    }

    public func captureFrame(at date: Date) throws -> CapturedFrame? {
        guard let frontmostWindow = findFrontmostWindow() else {
            return nil
        }

        guard let image = CGWindowListCreateImage(
            .null,
            .optionIncludingWindow,
            frontmostWindow.windowID,
            [.boundsIgnoreFraming, .bestResolution]
        ) else {
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
        guard let app = NSWorkspace.shared.frontmostApplication else {
            return nil
        }

        let ownerName = app.localizedName ?? "Unknown"
        guard let windowList = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else {
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
