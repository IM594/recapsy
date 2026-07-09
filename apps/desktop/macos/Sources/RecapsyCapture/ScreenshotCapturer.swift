import Foundation
import CoreGraphics
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// Outcome of one screenshot attempt: the encoded JPEG bytes, ready to write.
struct EncodedScreenshot {
    let jpegData: Data
    let pixelWidth: Int
    let pixelHeight: Int
}

enum ScreenshotError: Error {
    case permissionMissing
    case captureFailed
    case encodeFailed
}

/// Captures a single image of the main display via ScreenCaptureKit and encodes
/// it to a JPEG whose size lands in the product's ~100–800KB target band. The
/// ScreenCaptureKit call is async; this bridges it to a synchronous result with
/// a semaphore + timeout, matching the pattern proven in the old capture plugin,
/// and is always invoked off the main queue by `CaptureEngine`.
enum ScreenshotCapturer {
    /// Lossy-compression qualities tried in order. The first encoding at or
    /// below the upper size bound wins; if none fit, the smallest (last) is
    /// used. A near-blank screen may fall under the lower bound — accepted, as
    /// the band is a product target, not a hard invariant.
    private static let jpegQualities: [CGFloat] = [0.8, 0.65, 0.5, 0.35, 0.25]
    private static let maxTargetBytes = 800 * 1024
    private static let captureTimeout: DispatchTimeInterval = .seconds(5)

    static func capture() throws -> EncodedScreenshot {
        guard CGPreflightScreenCaptureAccess() else {
            // Trigger registration / the system prompt for the capture bundle's
            // own identity, then report the permission as missing for this tick.
            _ = CGRequestScreenCaptureAccess()
            throw ScreenshotError.permissionMissing
        }

        guard let cgImage = captureMainDisplayImage() else {
            throw ScreenshotError.captureFailed
        }

        guard let encoded = encodeJPEG(cgImage: cgImage) else {
            throw ScreenshotError.encodeFailed
        }
        return encoded
    }

    static var isScreenCaptureGranted: Bool {
        return CGPreflightScreenCaptureAccess()
    }

    private static func captureMainDisplayImage() -> CGImage? {
        let semaphore = DispatchSemaphore(value: 0)
        var result: CGImage?

        Task.detached {
            defer { semaphore.signal() }
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(
                    false,
                    onScreenWindowsOnly: true
                )
                let mainDisplayId = CGMainDisplayID()
                let display =
                    content.displays.first(where: { $0.displayID == mainDisplayId })
                    ?? content.displays.first
                guard let display else {
                    return
                }

                let filter = SCContentFilter(display: display, excludingWindows: [])
                let config = SCStreamConfiguration()
                let scale = filter.pointPixelScale
                config.width = Int(filter.contentRect.width * CGFloat(scale))
                config.height = Int(filter.contentRect.height * CGFloat(scale))
                config.showsCursor = false
                config.captureResolution = .best

                result = try await SCScreenshotManager.captureImage(
                    contentFilter: filter,
                    configuration: config
                )
            } catch {
                // Swallowed intentionally: the caller reports a generic
                // capture_failed; the underlying error may carry no useful,
                // privacy-safe detail across the process boundary.
            }
        }

        if semaphore.wait(timeout: .now() + captureTimeout) == .timedOut {
            return nil
        }
        return result
    }

    private static func encodeJPEG(cgImage: CGImage) -> EncodedScreenshot? {
        var best: Data?
        for quality in jpegQualities {
            guard let data = encode(cgImage: cgImage, quality: quality) else {
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
        return EncodedScreenshot(
            jpegData: data,
            pixelWidth: cgImage.width,
            pixelHeight: cgImage.height
        )
    }

    private static func encode(cgImage: CGImage, quality: CGFloat) -> Data? {
        let data = NSMutableData()
        guard
            let destination = CGImageDestinationCreateWithData(
                data as CFMutableData,
                UTType.jpeg.identifier as CFString,
                1,
                nil
            )
        else {
            return nil
        }
        let options: [CFString: Any] = [
            kCGImageDestinationLossyCompressionQuality: quality
        ]
        CGImageDestinationAddImage(destination, cgImage, options as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            return nil
        }
        return data as Data
    }
}
