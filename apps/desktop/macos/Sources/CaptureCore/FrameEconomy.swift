import CryptoKit
import Foundation

/// The safe, non-pixel identity for a capture target. A frame fingerprint is
/// only comparable inside one verified application window, so switching an
/// app or document window always admits the first frame.
public struct CaptureFrameContext: Equatable, Sendable {
    public let bundleId: String
    public let windowId: Int
    /// A sanitized stable context identity. It deliberately excludes the
    /// ScreenCaptureKit window id, AX node ids and transient view state.
    public let contextFingerprint: String?

    public init(bundleId: String, windowId: Int, contextFingerprint: String? = nil) {
        self.bundleId = bundleId
        self.windowId = windowId
        self.contextFingerprint = contextFingerprint
    }
}

/// A one-way digest of a heavily quantized low-resolution luminance sample.
/// It intentionally stores no screenshot bytes or reconstructable thumbnail.
public struct CaptureFrameFingerprint: Equatable, Sendable {
    public let context: CaptureFrameContext
    public let digest: String

    public init(context: CaptureFrameContext, digest: String) {
        self.context = context
        self.digest = digest
    }
}

/// A frame's coarse brightness signature from the same low-resolution sample
/// used for the accept/skip decision. Kept alongside the durable receipt
/// because it is a capture-time fact: the exact downsampled sample cannot be
/// reconstructed later from the encoded screenshot, and a later OCR pass can
/// use it to tell a genuine OCR failure apart from a low-contrast or
/// borderline-informative frame (`blurred` / `partial_capture`).
public struct CaptureFrameQuality: Codable, Equatable, Sendable {
    /// Mean sample luminance, quantized on the same 16-level scale as the
    /// near-duplicate digest (range 0...15).
    public let luminanceBucket: Int
    /// The sample was admitted for OCR, but its luminance range sits just
    /// above the blank floor — low-contrast content that is harder to read
    /// reliably.
    public let marginal: Bool

    public init(luminanceBucket: Int, marginal: Bool) {
        self.luminanceBucket = luminanceBucket
        self.marginal = marginal
    }
}

public enum CaptureFrameSkipReason: String, Equatable, Sendable {
    case blank
    case lowInformation = "low_information"
    case duplicate
}

public enum CaptureFrameEconomyDecision: Equatable, Sendable {
    case accept(CaptureFrameFingerprint)
    case skip(CaptureFrameSkipReason)
}

/// Frame filtering is deliberately conservative. Blank and low-information
/// classification is performed on the in-memory luminance sample before
/// near-duplicate detection. The digest uses 16-level quantized samples, which
/// ignores tiny display jitter but changes whenever a visible sampled glyph
/// crosses a quantization boundary. The current product policy accepts a false
/// negative (extra OCR work) over a false positive (lost visible text).
public enum CaptureFrameEconomy {
    public static let sampleWidth = 48
    public static let sampleHeight = 27

    private static let quantizationStep: UInt8 = 16

    public static func evaluate(
        luminance: [UInt8],
        width: Int,
        height: Int,
        context: CaptureFrameContext,
        previous: CaptureFrameFingerprint?
    ) -> CaptureFrameEconomyDecision {
        precondition(width > 0 && height > 0)
        precondition(luminance.count == width * height)

        switch CaptureFrameSampler.information(
            in: luminance,
            width: width,
            height: height
        ) {
        case .blank:
            return .skip(.blank)
        case .lowInformation:
            return .skip(.lowInformation)
        case .informative:
            break
        }

        let fingerprint = CaptureFrameFingerprint(
            context: context,
            digest: quantizedDigest(luminance)
        )
        if fingerprint == previous {
            return .skip(.duplicate)
        }
        return .accept(fingerprint)
    }

    /// Mean sample luminance quantized on the same scale as `quantizedDigest`,
    /// for `CaptureFrameQuality.luminanceBucket`.
    public static func luminanceBucket(_ luminance: [UInt8]) -> Int {
        guard !luminance.isEmpty else {
            return 0
        }
        let mean = luminance.reduce(0) { $0 + Int($1) } / luminance.count
        return mean / Int(quantizationStep)
    }

    private static func quantizedDigest(_ luminance: [UInt8]) -> String {
        let quantized = luminance.map { $0 / quantizationStep }
        let digest = SHA256.hash(data: Data(quantized))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
