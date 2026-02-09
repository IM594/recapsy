import CoreGraphics
import XCTest

@testable import RecapSenseCollector

final class ImageIOTests: XCTestCase {
  private func createTestImage(width: Int, height: Int) -> CGImage {
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue

    guard
      let ctx = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: bitmapInfo
      )
    else {
      fatalError("无法创建 CGContext")
    }

    // 灰底 + 黑块，模拟“界面 + 文字块”的低熵画面。
    ctx.setFillColor(CGColor(red: 0.92, green: 0.92, blue: 0.92, alpha: 1.0))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))

    ctx.setFillColor(CGColor(red: 0.1, green: 0.1, blue: 0.1, alpha: 1.0))
    for i in 0..<8 {
      ctx.fill(CGRect(x: 20, y: 20 + i * 36, width: width - 40, height: 14))
    }

    return ctx.makeImage()!
  }

  private func tempFileURL(ext: String) -> URL {
    FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString)
      .appendingPathExtension(ext)
  }

  override func tearDown() {
    super.tearDown()

    // 清理临时目录里本测试创建的 webp（保守：只删扩展名匹配的文件）。
    let tempDir = FileManager.default.temporaryDirectory
    try? FileManager.default.contentsOfDirectory(at: tempDir, includingPropertiesForKeys: nil)
      .filter { $0.pathExtension == "webp" }
      .forEach { try? FileManager.default.removeItem(at: $0) }
  }

  func testEncodeScreenshotWebPReturnsValidWebP() throws {
    let image = createTestImage(width: 720, height: 480)
    let result = try encodeScreenshotWebP(image: image)
    let data = result.data
    XCTAssertGreaterThan(data.count, 0)

    // WebP 格式: RIFF (0-3) + 文件大小 (4-7) + WEBP (8-11)
    let headerBytes = [UInt8](data.prefix(12))
    XCTAssertGreaterThanOrEqual(headerBytes.count, 12)
    XCTAssertEqual(headerBytes[0], 0x52) // R
    XCTAssertEqual(headerBytes[1], 0x49) // I
    XCTAssertEqual(headerBytes[2], 0x46) // F
    XCTAssertEqual(headerBytes[3], 0x46) // F
    XCTAssertEqual(headerBytes[8], 0x57) // W
    XCTAssertEqual(headerBytes[9], 0x45) // E
    XCTAssertEqual(headerBytes[10], 0x42) // B
    XCTAssertEqual(headerBytes[11], 0x50) // P
  }

  func testShouldUseNearLosslessBRespectsMinGainRatio() {
    // A 在硬上限内：B 必须至少省 5% 才会采用。
    XCTAssertFalse(shouldUseNearLosslessB(bytesA: 800_000, bytesB: 770_000)) // ~3.75%
    XCTAssertTrue(shouldUseNearLosslessB(bytesA: 800_000, bytesB: 750_000)) // ~6.25%
  }

  func testShouldUseNearLosslessBCanAvoidLossyFallback() {
    // A 超过 1MB，但 B 能压进来：直接用 B（避免进入 lossy/downscale）。
    XCTAssertTrue(shouldUseNearLosslessB(bytesA: 1_200_000, bytesB: 990_000))
  }
}
