import AppKit
import SwiftUI

struct LogsView: View {
  @EnvironmentObject var supervisor: Supervisor
  @State private var selected: LogSource = .agent
  @State private var content: String = ""
  @State private var errorMessage: String? = nil

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Picker("来源", selection: $selected) {
        Text("Agent").tag(LogSource.agent)
        Text("MCP（SSE）").tag(LogSource.mcp)
        Text("Collector").tag(LogSource.collector)
        Text("OCR（Collector）").tag(LogSource.collectorOcr)
      }
      .pickerStyle(.segmented)

      if let errorMessage {
        Text("错误：\(errorMessage)")
          .foregroundStyle(.red)
          .font(.caption)
      }

      ScrollView {
        Text(content.isEmpty ? "暂无日志（或尚未启动）。" : content)
          .font(.system(.caption, design: .monospaced))
          .frame(maxWidth: .infinity, alignment: .leading)
          .textSelection(.enabled)
      }
      .background(Color(nsColor: .textBackgroundColor))
      .overlay(
        RoundedRectangle(cornerRadius: 8)
          .stroke(Color.gray.opacity(0.25), lineWidth: 1)
      )

      HStack {
        Button("刷新") { load() }
        Button("复制当前日志") { copyToPasteboard(content) }
          .disabled(content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        Button("打开日志目录") { NSWorkspace.shared.open(supervisor.config.logsDir) }
        Spacer()
        Text("日志目录：\(supervisor.config.logsDir.path)")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .padding(16)
    .onAppear { load() }
    .onChange(of: selected) { _ in load() }
  }

  private func load() {
    errorMessage = nil
    let file = logFileURL(for: selected)
    guard let file else {
      content = ""
      return
    }

    do {
      // 默认多读一些，便于“一次性复制”给排障。
      content = try readTail(fileURL: file, maxBytes: 300_000)
    } catch {
      errorMessage = String(describing: error)
      content = ""
    }
  }

  private func logFileURL(for source: LogSource) -> URL? {
    let logsDir = supervisor.config.logsDir
    let filename: String
    switch source {
    case .agent:
      filename = "agent.log"
    case .mcp:
      filename = "mcp-sse.log"
    case .collector:
      filename = "collector.log"
    case .collectorOcr:
      filename = "collector-ocr.log"
    }
    return logsDir.appendingPathComponent(filename)
  }
}

private enum LogSource: String, CaseIterable, Hashable {
  case agent
  case mcp
  case collector
  case collectorOcr
}

private func readTail(fileURL: URL, maxBytes: Int) throws -> String {
  let handle = try FileHandle(forReadingFrom: fileURL)
  defer { try? handle.close() }

  let attrs = try FileManager.default.attributesOfItem(atPath: fileURL.path)
  let size = (attrs[.size] as? NSNumber)?.uint64Value ?? 0
  let tail = UInt64(max(0, maxBytes))
  let start = size > tail ? (size - tail) : 0

  try handle.seek(toOffset: start)
  let data = try handle.readToEnd() ?? Data()
  return String(decoding: data, as: UTF8.self)
}

private func copyToPasteboard(_ text: String) {
  let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return }
  let pb = NSPasteboard.general
  pb.clearContents()
  pb.setString(trimmed, forType: .string)
}
