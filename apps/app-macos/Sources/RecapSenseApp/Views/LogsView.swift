import AppKit
import SwiftUI

struct LogsView: View {
  @EnvironmentObject var supervisor: Supervisor
  @State private var selected: LogSource = .agent
  @State private var content: String = ""
  @State private var errorMessage: String? = nil
  @State private var loadingSource: LogSource? = nil

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

      ZStack {
        SelectableTextView(
          text: content.isEmpty ? "暂无日志（或尚未启动）。" : content,
          font: .monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)

        if loadingSource != nil {
          ProgressView()
        }
      }
      .background(Color(nsColor: .textBackgroundColor))
      .overlay(
        RoundedRectangle(cornerRadius: 8)
          .stroke(Color.gray.opacity(0.25), lineWidth: 1)
      )
      .clipShape(RoundedRectangle(cornerRadius: 8))

      HStack {
        Button("刷新") { Task { await load(source: selected) } }
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
    .task(id: selected) {
      await load(source: selected)
    }
  }

  @MainActor
  private func load(source: LogSource) async {
    loadingSource = source
    defer {
      // 避免“快速切换来源”时旧任务把新任务的 loading 状态清掉。
      if loadingSource == source {
        loadingSource = nil
      }
    }

    errorMessage = nil
    let file = logFileURL(for: source)
    guard let file else {
      if selected == source {
        content = ""
      }
      return
    }

    do {
      // 默认多读一些，便于“一次性复制”给排障。
      let text = try await Task.detached(priority: .utility) {
        try readTail(fileURL: file, maxBytes: 300_000)
      }.value

      if Task.isCancelled { return }
      guard selected == source else { return }
      content = text
    } catch {
      if Task.isCancelled { return }
      guard selected == source else { return }
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
