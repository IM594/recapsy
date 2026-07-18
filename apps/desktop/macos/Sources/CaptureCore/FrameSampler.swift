import CoreGraphics
import Foundation

public enum CaptureFrameInformation: Equatable {
    case blank
    case lowInformation
    case informative
}

/// Produces the low-resolution luminance sample used for blank and duplicate
/// admission. Both live capture and calibration tests must call this sampler
/// so scaling or color conversion changes cannot drift between them.
public enum CaptureFrameSampler {
    private static let maximumBlankLuminanceSpread: UInt8 = 6
    private static let maximumInformativeTransitions = 4

    public static func sampledLuminance(
        from image: CGImage,
        width: Int = CaptureFrameEconomy.sampleWidth,
        height: Int = CaptureFrameEconomy.sampleHeight
    ) -> [UInt8]? {
        precondition(width > 0 && height > 0)

        let bytesPerRow = width * 4
        var rgba = Array(repeating: UInt8(0), count: bytesPerRow * height)
        let colorSpace = CGColorSpaceCreateDeviceRGB()

        let didDraw = rgba.withUnsafeMutableBytes { buffer -> Bool in
            guard let baseAddress = buffer.baseAddress,
                  let context = CGContext(
                      data: baseAddress,
                      width: width,
                      height: height,
                      bitsPerComponent: 8,
                      bytesPerRow: bytesPerRow,
                      space: colorSpace,
                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
                  )
            else {
                return false
            }
            context.interpolationQuality = .low
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard didDraw else {
            return nil
        }

        var luminance: [UInt8] = []
        luminance.reserveCapacity(width * height)
        var offset = 0
        while offset < rgba.count {
            let red = UInt16(rgba[offset])
            let green = UInt16(rgba[offset + 1])
            let blue = UInt16(rgba[offset + 2])
            luminance.append(UInt8((54 * red + 183 * green + 19 * blue + 128) >> 8))
            offset += 4
        }
        return luminance
    }

    /// Classifies only information visible in the in-memory luminance sample.
    /// A non-blank sample is considered low-information only when at most one
    /// isolated sample point could account for all changes above the blank
    /// luminance band. Any larger spatial structure is admitted for OCR.
    public static func information(
        in luminance: [UInt8],
        width: Int,
        height: Int
    ) -> CaptureFrameInformation {
        precondition(width > 0 && height > 0)
        precondition(luminance.count == width * height)

        guard let darkest = luminance.min(), let brightest = luminance.max(),
              brightest &- darkest > maximumBlankLuminanceSpread
        else {
            return .blank
        }

        var transitionCount = 0
        for row in 0..<height {
            for column in 0..<width {
                let index = row * width + column
                if column + 1 < width,
                   isInformativeTransition(luminance[index], luminance[index + 1]) {
                    transitionCount += 1
                }
                if row + 1 < height,
                   isInformativeTransition(luminance[index], luminance[index + width]) {
                    transitionCount += 1
                }
                if transitionCount > maximumInformativeTransitions {
                    return .informative
                }
            }
        }
        return .lowInformation
    }

    private static func isInformativeTransition(_ left: UInt8, _ right: UInt8) -> Bool {
        let difference = left >= right ? left - right : right - left
        return difference > maximumBlankLuminanceSpread
    }
}
