import Foundation
import ImageIO
#if canImport(Vision)
import Vision
#endif

public final class VisionOCRProvider: OCRProvider {
    public init() {}

    public func recognize(frame: CapturedFrame) throws -> String {
        let mockedText = frame.mockedText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !mockedText.isEmpty {
            return mockedText
        }

        guard let imagePath = frame.imagePath, !imagePath.isEmpty else {
            throw RecaplySenseError.ocr(message: "missing imagePath")
        }

        #if canImport(Vision)
        let imageURL = URL(fileURLWithPath: imagePath)
        guard let source = CGImageSourceCreateWithURL(imageURL as CFURL, nil),
              let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            throw RecaplySenseError.ocr(message: "cannot decode image at \(imagePath)")
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        try handler.perform([request])

        let lines = (request.results ?? [])
            .compactMap { $0.topCandidates(1).first?.string }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        return lines.joined(separator: "\n")
        #else
        throw RecaplySenseError.ocr(message: "Vision framework unavailable")
        #endif
    }
}
