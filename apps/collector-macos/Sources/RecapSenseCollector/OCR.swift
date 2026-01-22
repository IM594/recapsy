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

struct OCRQuality: Equatable {
  let lines: Int
  let chars: Int
  let goodChars: Int
  let weirdChars: Int
  let goodRatio: Double
  let weirdRatio: Double

  /// 用于“选更好的 OCR 结果”的粗评分：好字符越多越好，怪字符越少越好。
  /// 注意：它不是语义评分，只是噪声/乱码程度的 proxy。
  var score: Double {
    Double(goodChars) - Double(weirdChars) * 2.0
  }
}

private func isHan(_ scalar: UnicodeScalar) -> Bool {
  // Swift 标准库在不同版本里对 Unicode script 支持不一致；
  // 为了兼容性，这里用常见汉字区间做判断（覆盖绝大多数中文场景）。
  let v = scalar.value
  // CJK Unified Ideographs
  if (0x4E00...0x9FFF).contains(v) { return true }
  // CJK Unified Ideographs Extension A
  if (0x3400...0x4DBF).contains(v) { return true }
  // CJK Compatibility Ideographs
  if (0xF900...0xFAFF).contains(v) { return true }
  return false
}

private func evaluateOCRQuality(_ text: String) -> OCRQuality {
  let trimmed = normalizeText(text)
  if trimmed.isEmpty {
    return OCRQuality(lines: 0, chars: 0, goodChars: 0, weirdChars: 0, goodRatio: 0, weirdRatio: 0)
  }

  let lines = trimmed.split(separator: "\n").count

  var chars = 0
  var good = 0
  var weird = 0

  for scalar in trimmed.unicodeScalars {
    if CharacterSet.whitespacesAndNewlines.contains(scalar) { continue }
    chars += 1

    if isHan(scalar) {
      good += 1
      continue
    }

    if scalar.value <= 0x7F {
      // ASCII：只把字母/数字计为“好字符”，其余符号不计入 good（但也不算 weird）。
      if CharacterSet.alphanumerics.contains(scalar) {
        good += 1
      }
      continue
    }

    // 非 ASCII 且非汉字：大概率是 OCR 噪声（例如 È、¥ 等），记为 weird。
    weird += 1
  }

  let goodRatio = chars > 0 ? Double(good) / Double(chars) : 0
  let weirdRatio = chars > 0 ? Double(weird) / Double(chars) : 0

  return OCRQuality(
    lines: lines,
    chars: chars,
    goodChars: good,
    weirdChars: weird,
    goodRatio: goodRatio,
    weirdRatio: weirdRatio
  )
}

/// 基于质量粗评估决定是否“值得尝试再跑一次 accurate OCR”。
///
/// 设计目标：
/// - fast 很快，但在低对比度/小字/噪声 UI 上容易乱码；
/// - accurate 更慢，但有时能显著改善；
/// - 我们只在 fast 结果明显“低信号”时才升级，避免常态增加 CPU 占用。
func shouldUpgradeFastOCR(_ quality: OCRQuality) -> Bool {
  // 明显太短：基本没识别到正文。
  if quality.goodChars < 80 { return true }
  // 好字符比例过低：多数为符号/噪声。
  if quality.goodRatio < 0.45 { return true }
  // 怪字符比例过高：常见乱码现象（例如大量 È、¥ 等）。
  if quality.weirdChars >= 12 && quality.weirdRatio > 0.10 { return true }
  return false
}

func recognizeText(
  from image: CGImage,
  level: OCRLevel,
  languages: [String]
) throws -> String {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = level.vnLevel
  // 语言纠错：
  // - 对英文正文通常更准；
  // - 对代码/命令可能会“纠错过度”。
  // 这里策略：fast 保守关闭；accurate 开启（提升整体可读性）。
  request.usesLanguageCorrection = (level == .accurate)
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
  // 经验：按位置排序能显著提升可读性（特别是多栏布局/复杂 UI）。
  // Vision 的 boundingBox 是归一化坐标，原点在左下角；我们按 y 从大到小（上到下）、x 从小到大排序。
  let sorted = observations.sorted { a, b in
    let ay = a.boundingBox.maxY
    let by = b.boundingBox.maxY
    if abs(ay - by) > 0.02 { return ay > by }
    return a.boundingBox.minX < b.boundingBox.minX
  }

  let lines: [String] = sorted.compactMap { obs in
    guard let cand = obs.topCandidates(1).first else { return nil }
    // 丢弃置信度极低的片段，减少乱码污染（但不过度激进）。
    if cand.confidence < 0.20 { return nil }
    return cand.string
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

/// 对外暴露：评估 OCR 文本质量（便于调试与自动策略）。
func evaluateOCRTextQuality(_ text: String) -> OCRQuality {
  evaluateOCRQuality(text)
}
