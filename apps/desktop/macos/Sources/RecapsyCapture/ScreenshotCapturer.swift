import Foundation
import AppKit
import CoreGraphics
import ScreenCaptureKit
import CaptureCore
import CWebP

/// Outcome of one screenshot attempt: the encoded WebP bytes, ready to write.
struct EncodedScreenshot {
    let imageData: Data
}

enum ScreenshotError: Error {
    case permissionMissing
    /// The foreground app has no capturable window this tick (e.g. Finder
    /// desktop with nothing open). Not an error surface — the caller skips the
    /// tick and retries on the next interval; no `capture.result` / `capture.error`.
    case noActiveWindow
    case captureFailed
    case encodeFailed
}

/// Captures a single image of the *current active window* via ScreenCaptureKit
/// and encodes it to a WebP whose size lands in the product's ~100–800KB target
/// band. The ScreenCaptureKit call is async; this bridges it to a synchronous
/// result with a semaphore + timeout, matching the pattern proven in the old
/// capture plugin, and is always invoked off the main queue by `CaptureEngine`.
enum ScreenshotCapturer {
    /// Lossy WebP qualities tried in order (0–100). The first encoding at or
    /// below the upper size bound wins; if none fit, the smallest (last) is
    /// used. A near-blank window may fall under the lower bound — accepted, as
    /// the band is a product target, not a hard invariant.
    private static let webpQualities: [Float] = [80, 65, 50, 35, 25]
    private static let maxTargetBytes = 800 * 1024
    private static let captureTimeout: DispatchTimeInterval = .seconds(5)

    static func capture() throws -> EncodedScreenshot {
        guard CGPreflightScreenCaptureAccess() else {
            // Trigger registration / the system prompt for the capture bundle's
            // own identity, then report the permission as missing for this tick.
            _ = CGRequestScreenCaptureAccess()
            throw ScreenshotError.permissionMissing
        }

        guard let frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier else {
            // No frontmost app resolvable (rare, transient) — treat like "no
            // window": skip this tick rather than emit a spurious error.
            throw ScreenshotError.noActiveWindow
        }

        let outcome = captureActiveWindowImage(frontmostPid: Int(frontmostPid))
        switch outcome {
        case .noWindow:
            throw ScreenshotError.noActiveWindow
        case .failed:
            throw ScreenshotError.captureFailed
        case .image(let cgImage):
            guard let encoded = encodeWebP(cgImage: cgImage) else {
                throw ScreenshotError.encodeFailed
            }
            return encoded
        }
    }

    static var isScreenCaptureGranted: Bool {
        return CGPreflightScreenCaptureAccess()
    }

    private enum CaptureOutcome {
        case image(CGImage)
        case noWindow
        case failed
    }

    private static func captureActiveWindowImage(frontmostPid: Int) -> CaptureOutcome {
        let semaphore = DispatchSemaphore(value: 0)
        var outcome: CaptureOutcome = .failed

        Task.detached {
            defer { semaphore.signal() }
            do {
                // Prefer on-screen-only first; if selection still fails, retry
                // with the broader SCK enumeration before giving up.
                var content = try await SCShareableContent.excludingDesktopWindows(
                    false,
                    onScreenWindowsOnly: true
                )
                var window = selectShareableWindow(
                    content: content,
                    frontmostPid: frontmostPid
                )
                if window == nil {
                    content = try await SCShareableContent.excludingDesktopWindows(
                        false,
                        onScreenWindowsOnly: false
                    )
                    window = selectShareableWindow(
                        content: content,
                        frontmostPid: frontmostPid
                    )
                }
                guard let window else {
                    outcome = .noWindow
                    return
                }

                let filter = SCContentFilter(desktopIndependentWindow: window)
                let config = SCStreamConfiguration()
                let scale = filter.pointPixelScale
                config.width = Int(filter.contentRect.width * CGFloat(scale))
                config.height = Int(filter.contentRect.height * CGFloat(scale))
                config.showsCursor = false
                config.captureResolution = .best

                let image = try await SCScreenshotManager.captureImage(
                    contentFilter: filter,
                    configuration: config
                )
                outcome = .image(image)
            } catch {
                // Swallowed intentionally: the caller reports a generic
                // capture_failed; the underlying error may carry no useful,
                // privacy-safe detail across the process boundary.
                outcome = .failed
            }
        }

        if semaphore.wait(timeout: .now() + captureTimeout) == .timedOut {
            return .failed
        }
        return outcome
    }

    /// Resolve an `SCWindow` for this tick.
    ///
    /// Order:
    /// 1. Frontmost app via SCK + `ActiveWindowSelector`.
    /// 2. Same rule over CGWindowList, then re-attach by `windowID` in SCK
    ///    (covers SCK `owningApplication` holes).
    /// 3. If the frontmost app has no capturable window, take the topmost
    ///    capturable on-screen window (CG front-to-back) and re-attach in SCK.
    ///    This covers hosts that remain NSWorkspace-frontmost with no visible
    ///    window (e.g. a dock-hidden Electron after its login window closes).
    private static func selectShareableWindow(
        content: SCShareableContent,
        frontmostPid: Int
    ) -> SCWindow? {
        let excluded: Set<Int> = [Int(getpid())]
        let sckInfos = content.windows.map(captureWindowInfo(from:))

        if let selectedId = ActiveWindowSelector.selectWindowId(
            windows: sckInfos,
            frontmostProcessId: frontmostPid
        ),
            let window = content.windows.first(where: { Int($0.windowID) == selectedId })
        {
            return window
        }

        let cgInfos = cgWindowInfos()
        if let cgSelectedId = ActiveWindowSelector.selectWindowId(
            windows: cgInfos,
            frontmostProcessId: frontmostPid
        ),
            let window = content.windows.first(where: { Int($0.windowID) == cgSelectedId })
        {
            return window
        }

        if let topId = ActiveWindowSelector.selectTopmostCapturableWindowId(
            windowsFrontToBack: cgInfos,
            excludingOwnerProcessIds: excluded
        ),
            let window = content.windows.first(where: { Int($0.windowID) == topId })
        {
            return window
        }

        return nil
    }

    private static func captureWindowInfo(from window: SCWindow) -> CaptureWindowInfo {
        CaptureWindowInfo(
            windowId: Int(window.windowID),
            ownerProcessId: Int(window.owningApplication?.processID ?? -1),
            layer: window.windowLayer,
            isOnScreen: window.isOnScreen,
            width: Double(window.frame.width),
            height: Double(window.frame.height),
            hasTitle: !(window.title ?? "").isEmpty
        )
    }

    private static func cgWindowInfos() -> [CaptureWindowInfo] {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return []
        }
        return raw.compactMap { entry in
            guard let pid = entry[kCGWindowOwnerPID as String] as? Int else {
                return nil
            }
            let bounds = entry[kCGWindowBounds as String] as? [String: CGFloat] ?? [:]
            let title = entry[kCGWindowName as String] as? String ?? ""
            return CaptureWindowInfo(
                windowId: entry[kCGWindowNumber as String] as? Int ?? -1,
                ownerProcessId: pid,
                layer: entry[kCGWindowLayer as String] as? Int ?? -1,
                isOnScreen: (entry[kCGWindowIsOnscreen as String] as? Int ?? 0) == 1,
                width: Double(bounds["Width"] ?? 0),
                height: Double(bounds["Height"] ?? 0),
                hasTitle: !title.isEmpty
            )
        }
    }

    // MARK: - WebP encoding

    private static func encodeWebP(cgImage: CGImage) -> EncodedScreenshot? {
        guard let rgb = rgbBytes(from: cgImage) else {
            return nil
        }

        var best: Data?
        for quality in webpQualities {
            guard let data = encode(rgb: rgb, quality: quality) else {
                continue
            }
            best = data
            if data.count <= maxTargetBytes {
                break
            }
        }
        guard let data = best else {
            return nil
        }
        return EncodedScreenshot(imageData: data)
    }

    private struct RGBImage {
        let bytes: [UInt8]
        let width: Int
        let height: Int
        /// Bytes per row of the packed 24-bit buffer: exactly `width * 3`.
        let bytesPerRow: Int
    }

    /// Produces a tightly-packed, fully *opaque* 24-bit RGB buffer for WebP.
    ///
    /// A screenshot is opaque, but a window capture carries anti-aliased,
    /// rounded corners whose edge pixels have partial alpha. CoreGraphics has no
    /// supported 8-bit-per-component *24-bit* RGB context, so we render into a
    /// 32-bit buffer with `CGImageAlphaInfo.noneSkipLast` — that forces every
    /// pixel opaque (source alpha ignored, no premultiplication) and leaves the
    /// 4th byte as unused padding. We then pack RGBX → RGB and encode with
    /// `WebPEncodeRGB`. This is why we do *not* feed the buffer to
    /// `WebPEncodeRGBA`: the padding byte is not a reliable 255, and WebP expects
    /// straight (not premultiplied) alpha, so treating padding as alpha would
    /// darken the rounded-corner edge pixels. Going through opaque RGB avoids
    /// that class of bug entirely.
    private static func rgbBytes(from cgImage: CGImage) -> RGBImage? {
        let width = cgImage.width
        let height = cgImage.height
        guard width > 0, height > 0 else {
            return nil
        }

        let srcBytesPerRow = width * 4
        var rgbx = [UInt8](repeating: 0, count: srcBytesPerRow * height)
        // Explicit sRGB (not device-dependent) so encoded colors are stable
        // across displays; fall back to device RGB only if sRGB is unavailable.
        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGImageAlphaInfo.noneSkipLast.rawValue

        let drawn: Bool = rgbx.withUnsafeMutableBytes { raw in
            guard
                let context = CGContext(
                    data: raw.baseAddress,
                    width: width,
                    height: height,
                    bitsPerComponent: 8,
                    bytesPerRow: srcBytesPerRow,
                    space: colorSpace,
                    bitmapInfo: bitmapInfo
                )
            else {
                return false
            }
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else {
            return nil
        }

        // Pack RGBX (4 bytes/pixel, 4th byte = padding) down to RGB (3
        // bytes/pixel). The source has no row padding (bytesPerRow == width*4),
        // so pixels are contiguous and index `i` maps to byte offset `i*4`.
        let dstBytesPerRow = width * 3
        var rgb = [UInt8](repeating: 0, count: dstBytesPerRow * height)
        rgbx.withUnsafeBufferPointer { src in
            rgb.withUnsafeMutableBufferPointer { dst in
                let pixelCount = width * height
                for i in 0..<pixelCount {
                    dst[i * 3 + 0] = src[i * 4 + 0]
                    dst[i * 3 + 1] = src[i * 4 + 1]
                    dst[i * 3 + 2] = src[i * 4 + 2]
                }
            }
        }
        return RGBImage(bytes: rgb, width: width, height: height, bytesPerRow: dstBytesPerRow)
    }

    private static func encode(rgb: RGBImage, quality: Float) -> Data? {
        var output: UnsafeMutablePointer<UInt8>?
        let size = rgb.bytes.withUnsafeBufferPointer { buffer -> Int in
            guard let base = buffer.baseAddress else {
                return 0
            }
            return WebPEncodeRGB(
                base,
                Int32(rgb.width),
                Int32(rgb.height),
                Int32(rgb.bytesPerRow),
                quality,
                &output
            )
        }
        guard size > 0, let output else {
            return nil
        }
        defer { WebPFree(output) }
        return Data(bytes: output, count: size)
    }
}
