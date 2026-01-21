import CoreGraphics

struct ImageHash: Equatable {
  let algorithm: String
  let value: UInt64

  var stringValue: String {
    let hex = String(value, radix: 16, uppercase: false).leftPadding(toLength: 16, withPad: "0")
    return "\(algorithm):\(hex)"
  }

  func hammingDistance(to other: ImageHash) -> Int? {
    guard algorithm == other.algorithm else { return nil }
    return (value ^ other.value).nonzeroBitCount
  }
}

enum ImageHashError: Error, CustomStringConvertible {
  case cannotCreateContext
  case cannotGetPixels

  var description: String {
    switch self {
    case .cannotCreateContext:
      return "无法创建缩放上下文（用于 hash 计算）"
    case .cannotGetPixels:
      return "无法读取像素（用于 hash 计算）"
    }
  }
}

func computeDHash64(from image: CGImage) throws -> ImageHash {
  // dHash：把图片缩到 9x8 灰度，然后比较每行相邻像素亮度（得到 64bit）
  let width = 9
  let height = 8

  let colorSpace = CGColorSpaceCreateDeviceGray()
  let bytesPerRow = width
  let bitsPerComponent = 8
  let bitmapInfo = CGImageAlphaInfo.none.rawValue

  guard
    let ctx = CGContext(
      data: nil,
      width: width,
      height: height,
      bitsPerComponent: bitsPerComponent,
      bytesPerRow: bytesPerRow,
      space: colorSpace,
      bitmapInfo: bitmapInfo
    )
  else {
    throw ImageHashError.cannotCreateContext
  }

  ctx.interpolationQuality = .low
  ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

  guard let data = ctx.data else {
    throw ImageHashError.cannotGetPixels
  }

  let pixels = data.bindMemory(to: UInt8.self, capacity: width * height)
  var hash: UInt64 = 0

  for y in 0..<height {
    let rowOffset = y * width
    for x in 0..<(width - 1) {
      let left = pixels[rowOffset + x]
      let right = pixels[rowOffset + x + 1]
      let bitIndex = (y * (width - 1)) + x // 0..63
      if left > right {
        hash |= (UInt64(1) << (63 - UInt64(bitIndex)))
      }
    }
  }

  return ImageHash(algorithm: "dhash64", value: hash)
}

private extension String {
  func leftPadding(toLength: Int, withPad: String) -> String {
    if count >= toLength { return self }
    return String(repeating: withPad, count: toLength - count) + self
  }
}

