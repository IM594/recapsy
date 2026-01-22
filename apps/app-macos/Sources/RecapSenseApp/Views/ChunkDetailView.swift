import AppKit
import SwiftUI

@MainActor
final class ChunkDetailViewModel: ObservableObject {
  @Published var isLoading = false
  @Published var errorMessage: String? = nil
  @Published var chunk: ChunkItem? = nil

  func load(chunkId: String) async {
    isLoading = true
    errorMessage = nil
    chunk = nil
    defer { isLoading = false }

    do {
      let client = try AgentHttpClient()
      chunk = try await client.getChunk(id: chunkId)
    } catch {
      errorMessage = String(describing: error)
    }
  }
}

struct ChunkDetailView: View {
  let chunkId: String
  @StateObject private var model = ChunkDetailViewModel()
  private static let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
  }()

  var body: some View {
    Group {
      if model.isLoading {
        VStack(spacing: 10) {
          ProgressView()
          Text("正在加载…")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if let error = model.errorMessage {
        VStack(alignment: .leading, spacing: 8) {
          Text("加载失败")
            .font(.headline)
          Text(error)
            .font(.caption)
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
          Spacer()
        }
        .padding(16)
      } else if let chunk = model.chunk {
        VStack(alignment: .leading, spacing: 10) {
          HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 6) {
              Text(chunk.app ?? "UnknownApp")
                .font(.headline)
              if let title = chunk.window_title, !title.isEmpty {
                Text(title)
                  .font(.subheadline)
                  .foregroundStyle(.secondary)
              }
              Text("\(formatDate(ms: chunk.start_ts)) → \(formatDate(ms: chunk.end_ts))")
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer()
          }

          Divider()

          SelectableTextView(
            text: chunk.text,
            font: .monospacedSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
          )
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .background(Color(nsColor: .textBackgroundColor))
          .overlay(
            RoundedRectangle(cornerRadius: 8)
              .stroke(Color.gray.opacity(0.25), lineWidth: 1)
          )
          .clipShape(RoundedRectangle(cornerRadius: 8))

          Divider()

          Text("id: \(chunk.id)")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
        }
        .padding(16)
      } else {
        VStack(spacing: 8) {
          Text("选择一条记录")
            .font(.headline)
          Text("在左侧列表中点击一条搜索结果，查看完整内容。")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .task(id: chunkId) {
      await model.load(chunkId: chunkId)
    }
  }

  private func formatDate(ms: Int64) -> String {
    let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
    return Self.isoFormatter.string(from: date)
  }
}
