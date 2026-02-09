import CoreGraphics
import Foundation
import libwebp

enum ImageWriteError: Error, CustomStringConvertible {
  case cannotCreateContext
  case cannotGetPixelBuffer
  case webpConfigInitFailed
  case webpConfigValidateFailed
  case webpPictureInitFailed
  case webpPictureImportFailed
  case webpEncodeFailed(String)
  case writeFailed(String)

  var description: String {
    switch self {
    case .cannotCreateContext:
      return "无法创建图片上下文（CGContext）"
    case .cannotGetPixelBuffer:
      return "无法获取像素缓冲区（context.data == nil）"
    case .webpConfigInitFailed:
      return "WebP 编码器初始化失败（WebPConfigInitInternal）"
    case .webpConfigValidateFailed:
      return "WebP 编码参数校验失败（WebPConfigValidate）"
    case .webpPictureInitFailed:
      return "WebP 图片对象初始化失败（WebPPictureInitInternal）"
    case .webpPictureImportFailed:
      return "WebP 像素导入失败（WebPPictureImportBGRA）"
    case .webpEncodeFailed(let message):
      return "WebP 编码失败：\(message)"
    case .writeFailed(let message):
      return "写入文件失败：\(message)"
    }
  }
}

// MARK: - 截图 WebP 压缩策略

enum ScreenshotWebPStage: String {
  /// A：near-lossless 95（更保守）
  case a = "A"
  /// B：near-lossless 92（更省，需满足 minGainRatio 才会采用）
  case b = "B"
  /// C：lossy text preset（仅用于 > 1MB 的硬上限兜底）
  case c = "C"
  /// D2：仍 > 1MB → 轻度 downscale（>= 0.75）后再走 lossy
  case d2 = "D2"
}

struct ScreenshotWebPEncodeDecision {
  let stage: ScreenshotWebPStage
  let downscaleRatio: Double
  let bytes: Int

  // 用于调试/可观测性：A/B 两档输出大小（仅在需要时才计算 B，避免额外 CPU）
  let bytesA: Int
  let bytesB: Int?

  // 当前实际使用的编码参数（便于日志打印）
  let nearLossless: Int?
  let lossyQuality: Int?
}

struct ScreenshotWebPEncodeResult {
  let data: Data
  let decision: ScreenshotWebPEncodeDecision
}

private enum ScreenshotWebPPolicy {
  // 用户目标：永远压在 1MB 内（这里用 1_000_000 bytes，保证在十进制/二进制口径下都不超）。
  static let hardLimitBytes = 1_000_000

  // 视觉无损（允许 near-lossless）
  static let nearLosslessA = 95
  static let nearLosslessB = 92
  static let minGainRatio = 0.05

  // > 1MB 兜底：文字友好的 lossy（preset=text, quality=93, sharp_yuv）
  // 说明：q 过高会导致少数全屏/高熵画面难以压进 1MB，从而触发多次 downscale/重试；
  // 这里稍降一点，换取更稳定的体积与更低的 CPU 抖动。
  static let lossyTextQuality: Float = 90

  // 只对极少数异常帧允许 downscale（D2）
  static let downscaleRatios: [Double] = [0.85, 0.75]

  // 编码“努力程度”：只影响 CPU，不影响画质（method 越高越省空间但更慢）
  // 说明：
  // - collector 是常驻进程，截图+OCR 的实时性比“每张图极限压缩”更重要；
  // - method=6 在部分机器/窗口下 CPU 峰值很高，且会放大多次编码策略的成本；
  // - 这里取中低档（2），显著降低 CPU；若体积偶发超限，交给 lossy/downscale 兜底。
  static let method: Int32 = 2

  // 只有当 near-lossless A “只是略超” 1MB 时，才值得额外再试一次 near-lossless B。
  // 经验：A 超出太多时，B 不太可能把它压进硬上限，只会白白增加一次编码 CPU。
  static let considerNearLosslessBMaxOvershootRatio: Double = 1.20

  // 极端兜底：如果到 0.75 + lossy(text) 仍然 > 1MB，则在不继续降分辨率的情况下逐步下调质量。
  // 说明：只在极少数异常帧触发，优先满足“永远 < 1MB”的硬约束。
  static let emergencyLossyQualities: [Float] = [80, 70, 60, 50]
}

func shouldUseNearLosslessB(
  bytesA: Int,
  bytesB: Int,
  hardLimitBytes: Int = ScreenshotWebPPolicy.hardLimitBytes,
  minGainRatio: Double = ScreenshotWebPPolicy.minGainRatio
) -> Bool {
  guard bytesA > 0, bytesB > 0 else { return false }
  guard bytesB < bytesA else { return false }

  // A 超过硬上限但 B 能压进来：直接用 B，避免进入 lossy/downscale。
  if bytesA > hardLimitBytes, bytesB <= hardLimitBytes { return true }

  // 其它情况：只有当 B 至少省 5% 才采用（minGainRatio=5%）。
  return Double(bytesB) <= Double(bytesA) * (1.0 - minGainRatio)
}

/// 截图落盘 WebP 编码：
/// - 默认 A=near-lossless 95；
/// - 如果 B=near-lossless 92 至少省 5%，则采用 B；
/// - 若仍 > 1MB：走 lossy(text,q=90)；
/// - 若仍 > 1MB：按 0.85→0.75 downscale 后再走 lossy；
/// - 极端兜底：0.75 + lossy(text) 仍超 1MB，则小幅降低 quality 确保 < 1MB。
func encodeScreenshotWebP(image: CGImage) throws -> ScreenshotWebPEncodeResult {
  enum FullSizeOutcome {
    case final(ScreenshotWebPEncodeResult)
    case needDownscale(bytesA: Int, bytesB: Int?)
  }

  let outcome: FullSizeOutcome = try withBGRAPixels(from: image) { pixels, width, height, bytesPerRow in
    let dataA = try encodeWebP(
      bgraPixels: pixels,
      width: width,
      height: height,
      bytesPerRow: bytesPerRow,
      config: makeNearLosslessConfig(level: ScreenshotWebPPolicy.nearLosslessA)
    )

    let bytesA = dataA.count
    var bytesB: Int? = nil

    // 常态优化：A 已经 <= 1MB 就直接用 A，不再为了“可能更小一点”而固定再编码一次 B。
    // 这样能显著降低 CPU 峰值，并减少“偶发很慢”的抖动。
    if dataA.count <= ScreenshotWebPPolicy.hardLimitBytes {
      return .final(
        ScreenshotWebPEncodeResult(
          data: dataA,
          decision: ScreenshotWebPEncodeDecision(
            stage: .a,
            downscaleRatio: 1.0,
            bytes: dataA.count,
            bytesA: bytesA,
            bytesB: nil,
            nearLossless: ScreenshotWebPPolicy.nearLosslessA,
            lossyQuality: nil
          )
        )
      )
    }

    // 仅当 A “略微”超限时才尝试 B（否则大概率无意义，只是多一次 CPU 开销）。
    var nearLosslessData = dataA
    var nearLosslessLevel = ScreenshotWebPPolicy.nearLosslessA
    var nearLosslessStage: ScreenshotWebPStage = .a

    let overshootLimit = Int(Double(ScreenshotWebPPolicy.hardLimitBytes) * ScreenshotWebPPolicy.considerNearLosslessBMaxOvershootRatio)
    if bytesA <= overshootLimit {
      let dataB = try encodeWebP(
        bgraPixels: pixels,
        width: width,
        height: height,
        bytesPerRow: bytesPerRow,
        config: makeNearLosslessConfig(level: ScreenshotWebPPolicy.nearLosslessB)
      )
      bytesB = dataB.count

      let useB = shouldUseNearLosslessB(bytesA: bytesA, bytesB: dataB.count)
      if useB {
        nearLosslessData = dataB
        nearLosslessLevel = ScreenshotWebPPolicy.nearLosslessB
        nearLosslessStage = .b
      }
    }

    if nearLosslessData.count <= ScreenshotWebPPolicy.hardLimitBytes {
      return .final(
        ScreenshotWebPEncodeResult(
          data: nearLosslessData,
          decision: ScreenshotWebPEncodeDecision(
            stage: nearLosslessStage,
            downscaleRatio: 1.0,
            bytes: nearLosslessData.count,
            bytesA: bytesA,
            bytesB: bytesB,
            nearLossless: nearLosslessLevel,
            lossyQuality: nil
          )
        )
      )
    }

    // > 1MB：兜底为 lossy(text)
    let lossyFull = try encodeWebP(
      bgraPixels: pixels,
      width: width,
      height: height,
      bytesPerRow: bytesPerRow,
      config: makeLossyTextConfig(quality: ScreenshotWebPPolicy.lossyTextQuality)
    )
    if lossyFull.count <= ScreenshotWebPPolicy.hardLimitBytes {
      return .final(
        ScreenshotWebPEncodeResult(
          data: lossyFull,
          decision: ScreenshotWebPEncodeDecision(
            stage: .c,
            downscaleRatio: 1.0,
            bytes: lossyFull.count,
            bytesA: bytesA,
            bytesB: bytesB,
            nearLossless: nil,
            lossyQuality: Int(ScreenshotWebPPolicy.lossyTextQuality)
          )
        )
      )
    }

    return .needDownscale(bytesA: bytesA, bytesB: bytesB)
  }

  switch outcome {
  case .final(let result):
    return result
  case .needDownscale(let bytesA, let bytesB):
    // 需要 downscale：避免重复复制像素缓冲区，这里按比例缩小后重新编码（lossy/text）。
    var lastAttempt: (data: Data, quality: Int, ratio: Double)? = nil

    for ratio in ScreenshotWebPPolicy.downscaleRatios {
      let scaled = try downscaleImage(image: image, ratio: ratio)
      let data = try encodeWebP(
        image: scaled,
        config: makeLossyTextConfig(quality: ScreenshotWebPPolicy.lossyTextQuality)
      )
      lastAttempt = (data: data, quality: Int(ScreenshotWebPPolicy.lossyTextQuality), ratio: ratio)
      if data.count <= ScreenshotWebPPolicy.hardLimitBytes {
        return ScreenshotWebPEncodeResult(
          data: data,
          decision: ScreenshotWebPEncodeDecision(
            stage: .d2,
            downscaleRatio: ratio,
            bytes: data.count,
            bytesA: bytesA,
            bytesB: bytesB,
            nearLossless: nil,
            lossyQuality: Int(ScreenshotWebPPolicy.lossyTextQuality)
          )
        )
      }
    }

    // 极端兜底：0.75 + lossy(text) 仍 > 1MB，则小幅降低 quality，优先保证硬上限。
    if let last = lastAttempt, last.ratio == ScreenshotWebPPolicy.downscaleRatios.last {
      let ratio = last.ratio
      let scaled = try downscaleImage(image: image, ratio: ratio)
      for q in ScreenshotWebPPolicy.emergencyLossyQualities {
        let data = try encodeWebP(
          image: scaled,
          config: makeLossyTextConfig(quality: q)
        )
        if data.count <= ScreenshotWebPPolicy.hardLimitBytes {
          return ScreenshotWebPEncodeResult(
            data: data,
            decision: ScreenshotWebPEncodeDecision(
              stage: .d2,
              downscaleRatio: ratio,
              bytes: data.count,
              bytesA: bytesA,
              bytesB: bytesB,
              nearLossless: nil,
              lossyQuality: Int(q)
            )
          )
        }
      }
    }

    let bestBytes = lastAttempt?.data.count ?? -1
    throw ImageWriteError.webpEncodeFailed("无法将截图压到 < 1MB（best=\(bestBytes) bytes）")
  }
}

// MARK: - libwebp 编码实现（WebPConfig + WebPPicture）

private func withBGRAPixels<T>(
  from image: CGImage,
  _ body: (UnsafePointer<UInt8>, Int, Int, Int) throws -> T
) throws -> T {
  let width = image.width
  let height = image.height
  guard width > 0, height > 0 else {
    throw ImageWriteError.webpEncodeFailed("invalid image size: \(width)x\(height)")
  }

  // 统一拿到 BGRA8（byteOrder32Little + premultipliedFirst），便于 WebPPictureImportBGRA。
  let colorSpace = CGColorSpaceCreateDeviceRGB()
  let bytesPerPixel = 4
  let bytesPerRow = bytesPerPixel * width
  let bitmapInfo =
    CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue

  guard
    let context = CGContext(
      data: nil,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: bytesPerRow,
      space: colorSpace,
      bitmapInfo: bitmapInfo
    )
  else {
    throw ImageWriteError.cannotCreateContext
  }

  // 不做重采样，仅做颜色空间/像素格式转换。
  context.interpolationQuality = .none
  context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

  guard let pixelData = context.data else {
    throw ImageWriteError.cannotGetPixelBuffer
  }

  return try body(
    pixelData.assumingMemoryBound(to: UInt8.self),
    width,
    height,
    bytesPerRow
  )
}

private func makeNearLosslessConfig(level: Int) throws -> WebPConfig {
  var config = WebPConfig()
  let initOk = WebPConfigInitInternal(&config, WEBP_PRESET_DEFAULT, 100.0, WEBP_ENCODER_ABI_VERSION)
  guard initOk != 0 else { throw ImageWriteError.webpConfigInitFailed }

  config.lossless = 1
  config.near_lossless = Int32(max(0, min(100, level)))
  config.quality = 100
  config.method = ScreenshotWebPPolicy.method
  config.alpha_quality = 100

  guard WebPValidateConfig(&config) != 0 else {
    throw ImageWriteError.webpConfigValidateFailed
  }

  return config
}

private func makeLossyTextConfig(quality: Float) throws -> WebPConfig {
  var config = WebPConfig()
  let ok = WebPConfigPreset(&config, WEBP_PRESET_TEXT, quality)
  guard ok != 0 else { throw ImageWriteError.webpConfigInitFailed }

  config.lossless = 0
  config.quality = quality
  config.method = ScreenshotWebPPolicy.method
  config.use_sharp_yuv = 1
  config.alpha_quality = 100

  guard WebPValidateConfig(&config) != 0 else {
    throw ImageWriteError.webpConfigValidateFailed
  }

  return config
}

private func encodeWebP(
  bgraPixels: UnsafePointer<UInt8>,
  width: Int,
  height: Int,
  bytesPerRow: Int,
  config: WebPConfig
) throws -> Data {
  var config = config

  var picture = WebPPicture()
  let initOk = WebPPictureInitInternal(&picture, WEBP_ENCODER_ABI_VERSION)
  guard initOk != 0 else { throw ImageWriteError.webpPictureInitFailed }
  defer { WebPPictureFree(&picture) }

  picture.width = Int32(width)
  picture.height = Int32(height)

  let importOk = WebPPictureImportBGRA(&picture, bgraPixels, Int32(bytesPerRow))
  guard importOk != 0 else { throw ImageWriteError.webpPictureImportFailed }

  // 使用内置内存 writer，避免先写临时文件。
  var writer = WebPMemoryWriter()
  WebPMemoryWriterInit(&writer)

  picture.writer = WebPMemoryWrite

  let encodedOk: Int32 = withUnsafeMutablePointer(to: &writer) { writerPtr in
    picture.custom_ptr = UnsafeMutableRawPointer(writerPtr)
    return WebPEncode(&config, &picture)
  }

  guard encodedOk != 0 else {
    let code = picture.error_code
    throw ImageWriteError.webpEncodeFailed("error_code=\(code)")
  }

  guard let mem = writer.mem, writer.size > 0 else {
    throw ImageWriteError.webpEncodeFailed("writer.mem == nil 或 writer.size == 0")
  }
  defer { WebPFree(mem) }

  return Data(bytes: mem, count: Int(writer.size))
}

private func encodeWebP(image: CGImage, config: WebPConfig) throws -> Data {
  try withBGRAPixels(from: image) { pixels, width, height, bytesPerRow in
    try encodeWebP(
      bgraPixels: pixels,
      width: width,
      height: height,
      bytesPerRow: bytesPerRow,
      config: config
    )
  }
}

private func downscaleImage(image: CGImage, ratio: Double) throws -> CGImage {
  let r = max(0.01, min(1.0, ratio))
  let srcW = max(1, image.width)
  let srcH = max(1, image.height)

  let dstW = max(1, Int(Double(srcW) * r))
  let dstH = max(1, Int(Double(srcH) * r))

  let colorSpace = CGColorSpaceCreateDeviceRGB()
  let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue

  guard
    let ctx = CGContext(
      data: nil,
      width: dstW,
      height: dstH,
      bitsPerComponent: 8,
      bytesPerRow: 0,
      space: colorSpace,
      bitmapInfo: bitmapInfo
    )
  else {
    throw ImageWriteError.cannotCreateContext
  }

  ctx.interpolationQuality = .high
  ctx.draw(image, in: CGRect(x: 0, y: 0, width: dstW, height: dstH))

  guard let out = ctx.makeImage() else {
    throw ImageWriteError.webpEncodeFailed("downscale ctx.makeImage() 失败")
  }
  return out
}
