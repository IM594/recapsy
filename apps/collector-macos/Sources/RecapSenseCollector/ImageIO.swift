import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum ImageWriteError: Error, CustomStringConvertible {
  case cannotCreateDestination
  case finalizeFailed

  var description: String {
    switch self {
    case .cannotCreateDestination:
      return "无法创建图片写入目标（CGImageDestination）"
    case .finalizeFailed:
      return "图片写入失败（CGImageDestinationFinalize）"
    }
  }
}

func resizeImage(_ image: CGImage, maxWidth: Int) -> CGImage {
  guard maxWidth > 0 else { return image }
  if image.width <= maxWidth { return image }

  let ratio = Double(maxWidth) / Double(image.width)
  let newWidth = maxWidth
  let newHeight = max(1, Int(Double(image.height) * ratio))

  let colorSpace = CGColorSpaceCreateDeviceRGB()
  let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue

  guard
    let ctx = CGContext(
      data: nil,
      width: newWidth,
      height: newHeight,
      bitsPerComponent: 8,
      bytesPerRow: 0,
      space: colorSpace,
      bitmapInfo: bitmapInfo
    )
  else {
    return image
  }

  ctx.interpolationQuality = .medium
  ctx.draw(image, in: CGRect(x: 0, y: 0, width: newWidth, height: newHeight))
  return ctx.makeImage() ?? image
}

func writeJpeg(image: CGImage, to url: URL, quality: CGFloat) throws {
  let options: [CFString: Any] = [
    kCGImageDestinationLossyCompressionQuality: quality,
  ]

  guard
    let destination = CGImageDestinationCreateWithURL(
      url as CFURL,
      UTType.jpeg.identifier as CFString,
      1,
      nil
    )
  else {
    throw ImageWriteError.cannotCreateDestination
  }

  CGImageDestinationAddImage(destination, image, options as CFDictionary)
  guard CGImageDestinationFinalize(destination) else {
    throw ImageWriteError.finalizeFailed
  }
}

