import AppKit
import CryptoKit
import Foundation

public struct FrameArtifact: Sendable {
    public let path: String
    public let hash: String

    public init(path: String, hash: String) {
        self.path = path
        self.hash = hash
    }
}

public final class FrameArtifactWriter {
    private let mediaDirectory: URL

    public init(mediaDirectory: URL) throws {
        self.mediaDirectory = mediaDirectory
        try FileManager.default.createDirectory(at: mediaDirectory, withIntermediateDirectories: true)
    }

    public func write(cgImage: CGImage, filename: String) throws -> FrameArtifact {
        let imageURL = mediaDirectory.appendingPathComponent(filename)

        do {
            try writePNG(cgImage: cgImage, to: imageURL)
            let imageData = try Data(contentsOf: imageURL)
            let hash = sha256Hex(data: imageData)
            return FrameArtifact(path: imageURL.path, hash: hash)
        } catch let error as RecaplySenseError {
            throw error
        } catch {
            throw RecaplySenseError.capture(message: "cannot persist frame artifact: \(error.localizedDescription)")
        }
    }

    private func writePNG(cgImage: CGImage, to url: URL) throws {
        let bitmap = NSBitmapImageRep(cgImage: cgImage)
        guard let data = bitmap.representation(using: .png, properties: [:]) else {
            throw RecaplySenseError.capture(message: "cannot convert screenshot to PNG")
        }

        do {
            try data.write(to: url, options: .atomic)
        } catch {
            throw RecaplySenseError.capture(message: "cannot write image to \(url.path): \(error.localizedDescription)")
        }
    }

    private func sha256Hex(data: Data) -> String {
        SHA256.hash(data: data)
            .map { String(format: "%02x", $0) }
            .joined()
    }
}
