import Foundation
import AppKit
import CoreGraphics
import Darwin
import ScreenCaptureKit
import CaptureCore
import CWebP

/// Outcome of one screenshot attempt: the encoded WebP bytes, ready to write.
struct EncodedScreenshot {
    let imageData: Data
    let source: CaptureWindowIdentity
    let sourceContext: CaptureSourceContext?
    let frameFingerprint: CaptureFrameFingerprint
    let frameQuality: CaptureFrameQuality
    /// Wall clock taken immediately after `SCScreenshotManager.captureImage`
    /// returns, distinct from the tick's scheduled `observedAt`.
    let capturedAt: String
    let policyDecision: CaptureSourcePolicyAction
}

enum ScreenshotError: Error, Sendable {
    case permissionMissing
    /// The foreground app has no capturable window this tick (e.g. Finder
    /// desktop with nothing open). Not an error surface — the caller skips the
    /// tick and retries on the next interval; no `capture.result` / `capture.error`.
    case noActiveWindow
    case policyDenied
    case blankFrame
    case lowInformationFrame
    case duplicateFrame
    case captureFailed
    case encodeFailed
}

/// Owns one asynchronous ScreenCaptureKit attempt. The worker can report a
/// timeout and request cancellation, but it must keep waiting for this attempt
/// to finish before beginning another one.
final class ScreenshotCaptureAttempt {
    private let resultGate = CaptureAsyncResultGate<Result<EncodedScreenshot, ScreenshotError>>()
    private let task: Task<Void, Never>

    init(operation: @escaping @Sendable () async -> Result<EncodedScreenshot, ScreenshotError>) {
        let resultGate = resultGate
        task = Task {
            resultGate.complete(await operation())
        }
    }

    func wait(until deadline: Date) -> Result<EncodedScreenshot, ScreenshotError>? {
        resultGate.wait(until: deadline)
    }

    func cancel() {
        task.cancel()
    }

    func waitUntilFinished() {
        _ = resultGate.waitUntilFinished()
    }
}

/// Captures a single image of the *current active window* via ScreenCaptureKit
/// and encodes it to a WebP whose size lands in the product's ~100–800KB target
/// band. ScreenCaptureKit work is owned by `ScreenshotCaptureAttempt`, which
/// prevents a timed-out attempt from overlapping a later timer tick.
enum ScreenshotCapturer {
    /// Lossy WebP qualities tried in order (0–100). The first encoding at or
    /// below the upper size bound wins; if none fit, the smallest (last) is
    /// used. A near-blank window may fall under the lower bound — accepted, as
    /// the band is a product target, not a hard invariant.
    private static let webpQualities: [Float] = [80, 65, 50, 35, 25]
    private static let maxTargetBytes = 800 * 1024
    static let captureTimeout: TimeInterval = 5

    static func beginCapture(
        policy: CaptureSourcePolicy,
        previousFingerprint: CaptureFrameFingerprint?
    ) throws -> ScreenshotCaptureAttempt {
        guard ScreenCaptureAuthorization.probe({ CGPreflightScreenCaptureAccess() }) else {
            // Capture is a background operation. A missing permission is
            // reported to the shell, but must never summon a macOS prompt from
            // this timer-driven path. The dedicated, user-initiated permission
            // command below is the sole request path.
            throw ScreenshotError.permissionMissing
        }

        // Never trust NSWorkspace.frontmostApplication here: Electron hosts can
        // stay "frontmost" in Launch Services while the user is clicking in
        // another app. Selection uses CGWindowList Z-order instead.
        let excludedOwnerProcessIds: Set<Int> = [Int(getpid())]

        return ScreenshotCaptureAttempt {
            await captureActiveWindow(
                excludingOwnerProcessIds: excludedOwnerProcessIds,
                policy: policy,
                previousFingerprint: previousFingerprint
            )
        }
    }

    static var isScreenCaptureGranted: Bool {
        return ScreenCaptureAuthorization.probe({ CGPreflightScreenCaptureAccess() })
    }

    /// The only native path permitted to invoke the macOS Screen Recording
    /// request API. It first performs a side-effect-free preflight check, so a
    /// user who already granted access is never shown a redundant prompt.
    static func requestScreenCaptureAccessIfNeeded() -> Bool {
        return ScreenCaptureAuthorization.requestIfNeeded(
            preflight: { CGPreflightScreenCaptureAccess() },
            request: { CGRequestScreenCaptureAccess() }
        )
    }

    private static func captureActiveWindow(
        excludingOwnerProcessIds: Set<Int>,
        policy: CaptureSourcePolicy,
        previousFingerprint: CaptureFrameFingerprint?
    ) async -> Result<EncodedScreenshot, ScreenshotError> {
        do {
            try Task.checkCancellation()
                // Prefer on-screen-only first; if selection still fails, retry
                // with the broader SCK enumeration before giving up.
            var content = try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: true
            )
            try Task.checkCancellation()
            var window = selectShareableWindow(
                content: content,
                excludingOwnerProcessIds: excludingOwnerProcessIds
            )
            if window == nil {
                content = try await SCShareableContent.excludingDesktopWindows(
                    false,
                    onScreenWindowsOnly: false
                )
                try Task.checkCancellation()
                window = selectShareableWindow(
                    content: content,
                    excludingOwnerProcessIds: excludingOwnerProcessIds
                )
            }
            guard let window else {
                return .failure(.noActiveWindow)
            }
            guard let application = CaptureApplicationPayload.fromRuntimeMetadata(
                name: window.owningApplication?.applicationName,
                bundleId: window.owningApplication?.bundleIdentifier
            ) else {
                return .failure(.policyDenied)
            }
            guard let ownerProcessId = window.owningApplication?.processID, ownerProcessId > 0 else {
                return .failure(.policyDenied)
            }
            let source = CaptureWindowIdentity(
                application: application,
                windowId: Int(window.windowID),
                ownerProcessId: Int(ownerProcessId)
            )
            let sourceIdentity = CaptureSourceIdentity(
                applicationName: application.name,
                bundleId: application.bundleId
            )
            let sourcePolicyDecision = CaptureSourcePolicyEvaluator.decide(
                policy: policy,
                source: sourceIdentity
            )
            guard sourcePolicyDecision.action != .blockCapture else {
                return .failure(.policyDenied)
            }

            // Domain policy is intentionally evaluated only after a direct AX
            // sample produced a sanitized host. A missing Accessibility grant or
            // URL therefore omits metadata instead of blocking unrelated apps.
            let sourceContext = AccessibilityContextSampler.sample(
                processId: Int32(ownerProcessId),
                application: application,
                windowId: Int(window.windowID)
            )
            let policyDecision = CaptureSourcePolicyEvaluator.decide(
                policy: policy,
                source: sourceIdentity,
                context: sourceContext
            )
            guard policyDecision.action != .blockCapture else {
                return .failure(.policyDenied)
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
            // Taken immediately on return from the capture call, before any
            // further work — the closest available wall-clock bound on when
            // the frame was actually presented.
            let capturedAt = CaptureEngine.iso8601(Date())
            try Task.checkCancellation()
            guard let luminance = CaptureFrameSampler.sampledLuminance(from: image) else {
                return .failure(.captureFailed)
            }
            let frameDecision = CaptureFrameEconomy.evaluate(
                luminance: luminance,
                width: CaptureFrameEconomy.sampleWidth,
                height: CaptureFrameEconomy.sampleHeight,
                context: CaptureFrameContext(
                    bundleId: application.bundleId,
                    windowId: Int(window.windowID),
                    contextFingerprint: sourceContext?.fingerprint
                ),
                previous: previousFingerprint
            )
            switch frameDecision {
            case .skip(.blank):
                return .failure(.blankFrame)
            case .skip(.lowInformation):
                return .failure(.lowInformationFrame)
            case .skip(.duplicate):
                return .failure(.duplicateFrame)
            case .accept(let fingerprint):
                guard let encoded = encodeWebP(cgImage: image) else {
                    return .failure(.encodeFailed)
                }
                let quality = CaptureFrameQuality(
                    luminanceBucket: CaptureFrameEconomy.luminanceBucket(luminance),
                    marginal: CaptureFrameSampler.isLowContrast(luminance)
                )
                return .success(EncodedScreenshot(
                    imageData: encoded,
                    source: source,
                    sourceContext: sourceContext,
                    frameFingerprint: fingerprint,
                    frameQuality: quality,
                    capturedAt: capturedAt,
                    policyDecision: policyDecision.action
                ))
            }
        } catch {
            // The underlying error may contain no privacy-safe detail for the
            // process boundary. Cancellation is likewise a generic failure.
            return .failure(.captureFailed)
        }
    }

    /// Resolve a verified `SCWindow` for this tick from visual Z-order.
    /// Nominate with front-to-back `CGWindowList`, then re-authorize the id
    /// against ScreenCaptureKit ownership metadata before reading pixels.
    private static func selectShareableWindow(
        content: SCShareableContent,
        excludingOwnerProcessIds: Set<Int>
    ) -> SCWindow? {
        let sckInfos = content.windows.map(captureWindowInfo(from:))
        let cgInfos = cgWindowInfos()
        guard let selectedId = ActiveWindowSelector.selectTopmostCapturableWindowId(
            windowsFrontToBack: cgInfos,
            excludingOwnerProcessIds: excludingOwnerProcessIds
        ),
            let verifiedId = ActiveWindowSelector.verifySelectedWindowId(
                selectedWindowId: selectedId,
                finalWindows: sckInfos
            ),
            let window = content.windows.first(where: { Int($0.windowID) == verifiedId })
        else {
            return nil
        }

        return window
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

    private static func encodeWebP(cgImage: CGImage) -> Data? {
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
        return data
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
