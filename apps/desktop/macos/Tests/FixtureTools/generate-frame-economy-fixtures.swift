import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct RGB {
    let red: UInt8
    let green: UInt8
    let blue: UInt8
}

struct Canvas {
    static let width = 480
    static let height = 270

    private(set) var pixels = Array(
        repeating: UInt8(255),
        count: width * height * 4
    )

    mutating func fill(_ color: RGB) {
        fillRectangle(x: 0, y: 0, width: Self.width, height: Self.height, color: color)
    }

    mutating func fillRectangle(
        x: Int,
        y: Int,
        width: Int,
        height: Int,
        color: RGB
    ) {
        precondition(x >= 0 && y >= 0)
        precondition(x + width <= Self.width && y + height <= Self.height)

        for row in y..<(y + height) {
            for column in x..<(x + width) {
                let offset = (row * Self.width + column) * 4
                pixels[offset] = color.red
                pixels[offset + 1] = color.green
                pixels[offset + 2] = color.blue
                pixels[offset + 3] = 255
            }
        }
    }

    func writePNG(to url: URL) throws {
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let data = Data(pixels)
        guard let provider = CGDataProvider(data: data as CFData),
              let image = CGImage(
                  width: Self.width,
                  height: Self.height,
                  bitsPerComponent: 8,
                  bitsPerPixel: 32,
                  bytesPerRow: Self.width * 4,
                  space: colorSpace,
                  bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                  provider: provider,
                  decode: nil,
                  shouldInterpolate: false,
                  intent: .defaultIntent
              ),
              let destination = CGImageDestinationCreateWithURL(
                  url as CFURL,
                  UTType.png.identifier as CFString,
                  1,
                  nil
              )
        else {
            throw FixtureGenerationError.imageCreationFailed
        }

        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw FixtureGenerationError.imageWriteFailed
        }
    }
}

enum FixtureGenerationError: Error {
    case imageCreationFailed
    case imageWriteFailed
}

private let background = RGB(red: 246, green: 247, blue: 249)
private let toolbar = RGB(red: 55, green: 58, blue: 64)
private let sidebar = RGB(red: 226, green: 229, blue: 234)
private let divider = RGB(red: 196, green: 200, blue: 207)
private let surface = RGB(red: 255, green: 255, blue: 255)
private let primaryInk = RGB(red: 61, green: 65, blue: 73)
private let secondaryInk = RGB(red: 133, green: 139, blue: 150)

private func baseApplicationScreenshot(toolbarColor: RGB = toolbar) -> Canvas {
    var canvas = Canvas()
    canvas.fill(background)
    canvas.fillRectangle(x: 0, y: 0, width: 480, height: 44, color: toolbarColor)
    canvas.fillRectangle(x: 0, y: 44, width: 104, height: 226, color: sidebar)
    canvas.fillRectangle(x: 103, y: 44, width: 1, height: 226, color: divider)

    canvas.fillRectangle(x: 16, y: 14, width: 62, height: 15, color: RGB(red: 224, green: 227, blue: 232))
    canvas.fillRectangle(x: 424, y: 13, width: 22, height: 18, color: RGB(red: 91, green: 96, blue: 105))
    canvas.fillRectangle(x: 454, y: 13, width: 12, height: 18, color: RGB(red: 91, green: 96, blue: 105))

    for y in [66, 91, 116, 141] {
        canvas.fillRectangle(x: 16, y: y, width: 68, height: 9, color: secondaryInk)
    }

    canvas.fillRectangle(x: 124, y: 62, width: 328, height: 184, color: surface)
    canvas.fillRectangle(x: 144, y: 82, width: 154, height: 13, color: primaryInk)
    canvas.fillRectangle(x: 144, y: 108, width: 269, height: 7, color: secondaryInk)
    canvas.fillRectangle(x: 144, y: 124, width: 236, height: 7, color: secondaryInk)
    canvas.fillRectangle(x: 144, y: 156, width: 126, height: 10, color: primaryInk)
    canvas.fillRectangle(x: 144, y: 181, width: 250, height: 7, color: secondaryInk)
    canvas.fillRectangle(x: 144, y: 197, width: 204, height: 7, color: secondaryInk)
    return canvas
}

private let scriptURL = URL(fileURLWithPath: #filePath)
private let fixtureDirectory = scriptURL
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .appendingPathComponent("CaptureCoreTests/Fixtures/FrameEconomy", isDirectory: true)

try FileManager.default.createDirectory(at: fixtureDirectory, withIntermediateDirectories: true)

var blank = Canvas()
blank.fill(RGB(red: 252, green: 252, blue: 252))
try blank.writePNG(to: fixtureDirectory.appendingPathComponent("blank-surface.png"))

var blankBoundary = Canvas()
blankBoundary.fill(RGB(red: 248, green: 248, blue: 248))
blankBoundary.fillRectangle(
    x: 0,
    y: 230,
    width: 480,
    height: 40,
    color: RGB(red: 254, green: 254, blue: 254)
)
try blankBoundary.writePNG(to: fixtureDirectory.appendingPathComponent("blank-six-level-band.png"))

let base = baseApplicationScreenshot()
try base.writePNG(to: fixtureDirectory.appendingPathComponent("application-base.png"))

let compositorJitter = baseApplicationScreenshot(
    toolbarColor: RGB(red: 56, green: 59, blue: 65)
)
try compositorJitter.writePNG(
    to: fixtureDirectory.appendingPathComponent("application-compositor-jitter.png")
)

var statusChanged = baseApplicationScreenshot()
statusChanged.fillRectangle(
    x: 428,
    y: 16,
    width: 14,
    height: 14,
    color: RGB(red: 45, green: 181, blue: 93)
)
try statusChanged.writePNG(
    to: fixtureDirectory.appendingPathComponent("application-status-change.png")
)

var contentChanged = baseApplicationScreenshot()
contentChanged.fillRectangle(x: 144, y: 181, width: 250, height: 7, color: surface)
contentChanged.fillRectangle(x: 144, y: 181, width: 119, height: 7, color: primaryInk)
contentChanged.fillRectangle(x: 144, y: 213, width: 226, height: 7, color: secondaryInk)
try contentChanged.writePNG(
    to: fixtureDirectory.appendingPathComponent("application-content-change.png")
)
