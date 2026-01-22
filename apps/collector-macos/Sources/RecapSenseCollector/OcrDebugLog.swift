import Foundation

/// OCR 全文调试日志（高隐私、高体量）。
///
/// 设计原则：
/// - 默认不启用；只有显式开启时才写入（避免把用户屏幕全文落盘）
/// - 写入到 `${DATA_DIR}/logs/collector-ocr.log`，方便在菜单栏 App 的“日志”页直接复制
/// - 简单轮转：超过上限后把当前文件移动为 `.1`，重新开始写入
final class OcrDebugLog {
  private let fileURL: URL
  private let rotatedURL: URL
  private let maxBytes: UInt64
  private var handle: FileHandle? = nil

  init(logsDir: URL, maxBytes: UInt64) throws {
    self.fileURL = logsDir.appendingPathComponent("collector-ocr.log")
    self.rotatedURL = logsDir.appendingPathComponent("collector-ocr.log.1")
    self.maxBytes = maxBytes

    try FileManager.default.createDirectory(at: logsDir, withIntermediateDirectories: true)
    if !FileManager.default.fileExists(atPath: fileURL.path) {
      FileManager.default.createFile(atPath: fileURL.path, contents: nil)
    }

    let handle = try FileHandle(forWritingTo: fileURL)
    try handle.seekToEnd()
    self.handle = handle
  }

  deinit {
    try? handle?.close()
  }

  func append(_ entry: String) {
    do {
      try rotateIfNeeded()
      guard let handle else { return }
      guard let data = entry.data(using: .utf8) else { return }
      try handle.write(contentsOf: data)
    } catch {
      // OCR 日志失败不应影响采集主流程（忽略）
    }
  }

  private func rotateIfNeeded() throws {
    let attrs = try FileManager.default.attributesOfItem(atPath: fileURL.path)
    let size = (attrs[.size] as? NSNumber)?.uint64Value ?? 0
    if size < maxBytes { return }

    try handle?.close()
    handle = nil

    let fm = FileManager.default
    if fm.fileExists(atPath: rotatedURL.path) {
      try? fm.removeItem(at: rotatedURL)
    }
    if fm.fileExists(atPath: fileURL.path) {
      try fm.moveItem(at: fileURL, to: rotatedURL)
    }
    fm.createFile(atPath: fileURL.path, contents: nil)

    let handle = try FileHandle(forWritingTo: fileURL)
    try handle.seekToEnd()
    self.handle = handle
  }
}

