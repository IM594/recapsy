import Foundation
import CryptoKit

/// Pure asset-addressing helpers shared by the capture executable and its unit
/// tests. All of these are side-effect free so the cross-process contract
/// (relative key format, on-disk path join, content hash) is testable without
/// touching the screen, the filesystem, or the clock.
public enum CaptureAsset {
    /// Fixed screenshot filename inside a capture's directory.
    public static let screenshotFileName = "screenshot.webp"

    public static let screenshotMimeType = "image/webp"

    /// Relative access key carried in `capture.result` `asset.ref`. This is the
    /// *only* form allowed across the process boundary — never an absolute path
    /// or `file://` (the protocol layer rejects those). The sync loop joins this
    /// exact string onto the shared asset root to read the bytes back, so it
    /// must be a stable `<captureId>/screenshot.webp`.
    public static func screenshotRelativeKey(captureId: String) -> String {
        return "\(captureId)/\(screenshotFileName)"
    }

    /// Absolute on-disk destination for a capture's WebP image, derived from the
    /// injected asset root (`RECAPSY_CAPTURE_ASSET_ROOT`) and the capture id.
    /// Never hard-coded; the root always comes from the environment.
    public static func screenshotFileURL(assetRoot: URL, captureId: String) -> URL {
        return assetRoot
            .appendingPathComponent(captureId, isDirectory: true)
            .appendingPathComponent(screenshotFileName, isDirectory: false)
    }

    /// Directory that holds a capture's assets (must exist before writing).
    public static func captureDirectoryURL(assetRoot: URL, captureId: String) -> URL {
        return assetRoot.appendingPathComponent(captureId, isDirectory: true)
    }

    /// Content hash in the `sha256:<hex>` form the sync layer stores as the
    /// asset content address.
    public static func contentHash(for data: Data) -> String {
        let digest = SHA256.hash(data: data)
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return "sha256:\(hex)"
    }
}

/// Generates capture ids constrained to `[A-Za-z0-9-]`, which pass unchanged
/// through the sync layer's `redactSensitiveString` / opaque-ref checks (no
/// slash, no absolute-path prefix, no secret-looking token). Kept pure by
/// injecting the millisecond clock and a monotonic counter.
public enum CaptureIdGenerator {
    public static func make(epochMilliseconds: Int64, counter: Int) -> String {
        return "cap-\(epochMilliseconds)-\(counter)"
    }
}
