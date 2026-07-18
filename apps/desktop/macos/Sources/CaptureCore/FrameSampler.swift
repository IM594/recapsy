import CoreGraphics
import Foundation

/// Produces the low-resolution luminance sample used for blank and duplicate
/// admission. Both live capture and calibration tests must call this sampler
/// so scaling or color conversion changes cannot drift between them.
public enum CaptureFrameSampler {
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
}
