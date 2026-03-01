import AppKit
import Foundation
import Testing
@testable import RecaplySenseCore

struct FrameArtifactWriterTests {
    @Test("FrameArtifactWriter 应写入图片并生成哈希")
    func shouldWriteArtifactWithHash() throws {
        let mediaDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("recaply-sense-artifacts-\(UUID().uuidString)", isDirectory: true)

        let writer = try FrameArtifactWriter(mediaDirectory: mediaDirectory)
        let image = try #require(makeImage(color: .systemBlue))

        let artifact = try writer.write(
            cgImage: image,
            filename: "artifact-a.png"
        )

        #expect(FileManager.default.fileExists(atPath: artifact.path))
        #expect(!artifact.hash.isEmpty)
    }

    @Test("FrameArtifactWriter 对同图像应生成一致哈希")
    func shouldGenerateStableHashForSameImage() throws {
        let mediaDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("recaply-sense-artifacts-hash-\(UUID().uuidString)", isDirectory: true)

        let writer = try FrameArtifactWriter(mediaDirectory: mediaDirectory)
        let image = try #require(makeImage(color: .systemRed))

        let a = try writer.write(cgImage: image, filename: "artifact-a.png")
        let b = try writer.write(cgImage: image, filename: "artifact-b.png")

        #expect(a.hash == b.hash)
    }

    @Test("FrameArtifactWriter 当目录不可写时应抛错")
    func shouldThrowWhenDirectoryIsNotWritable() throws {
        let mediaDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("recaply-sense-artifacts-ro-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: mediaDirectory, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: mediaDirectory.path)

        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: mediaDirectory.path)
        }

        let writer = try FrameArtifactWriter(mediaDirectory: mediaDirectory)
        let image = try #require(makeImage(color: .systemGreen))

        #expect(throws: RecaplySenseError.self) {
            _ = try writer.write(cgImage: image, filename: "artifact-fail.png")
        }
    }
}

private func makeImage(color: NSColor) -> CGImage? {
    guard let context = CGContext(
        data: nil,
        width: 1,
        height: 1,
        bitsPerComponent: 8,
        bytesPerRow: 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        return nil
    }

    context.setFillColor(color.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: 1, height: 1))
    return context.makeImage()
}
