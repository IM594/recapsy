import CoreGraphics
import Foundation
import Vision

enum OCRError: Error, CustomStringConvertible {
  case requestFailed(String)

  var description: String {
    switch self {
    case .requestFailed(let message):
      return "OCR 失败：\(message)"
    }
  }
}

enum OCRLevel: String {
  case fast
  case accurate

  var vnLevel: VNRequestTextRecognitionLevel {
    switch self {
    case .fast: return .fast
    case .accurate: return .accurate
    }
  }
}

func recognizeText(
  from image: CGImage,
  level: OCRLevel,
  languages: [String]
) throws -> String {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = level.vnLevel
  request.usesLanguageCorrection = false
  if !languages.isEmpty {
    request.recognitionLanguages = languages
  }

  let handler = VNImageRequestHandler(cgImage: image, options: [:])
  do {
    try handler.perform([request])
  } catch {
    throw OCRError.requestFailed(String(describing: error))
  }

  let observations = request.results ?? []
  let lines: [String] = observations.compactMap { obs in
    obs.topCandidates(1).first?.string
  }

  return normalizeText(lines.joined(separator: "\n"))
}

func normalizeText(_ text: String) -> String {
  text
    .replacingOccurrences(of: "\r\n", with: "\n")
    .replacingOccurrences(of: "\t", with: " ")
    .split(whereSeparator: { $0 == "\n" || $0 == "\r" })
    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty }
    .joined(separator: "\n")
    .trimmingCharacters(in: .whitespacesAndNewlines)
}

