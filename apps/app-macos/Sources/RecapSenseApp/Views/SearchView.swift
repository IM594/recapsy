import SwiftUI

@MainActor
final class SearchViewModel: ObservableObject {
  @Published var query: String = ""
  @Published var limit: Int = 10
  @Published var isLoading: Bool = false
  @Published var errorMessage: String? = nil
  @Published var results: [SearchResultItem] = []

  func search() async {
    isLoading = true
    errorMessage = nil
    defer { isLoading = false }

    do {
      let client = try AgentHttpClient()
      results = try await client.search(query: query, limit: limit)
    } catch {
      errorMessage = String(describing: error)
      results = []
    }
  }
}

struct SearchView: View {
  @StateObject private var model = SearchViewModel()
  @State private var selectedChunkId: String? = nil

  var body: some View {
    NavigationSplitView {
      VStack(alignment: .leading, spacing: 12) {
        HStack(spacing: 10) {
          TextField("输入关键词（空表示最近）", text: $model.query)
            .textFieldStyle(.roundedBorder)
            .onSubmit { Task { await searchAndSelectFirstIfNeeded() } }

          Stepper("limit \(model.limit)", value: $model.limit, in: 1...50)
            .frame(width: 160)

          Button(model.isLoading ? "搜索中…" : "搜索") {
            Task { await searchAndSelectFirstIfNeeded() }
          }
          .disabled(model.isLoading)
          .keyboardShortcut(.return, modifiers: [.command])
        }

        if let error = model.errorMessage {
          Text("错误：\(error)")
            .foregroundStyle(.red)
            .font(.caption)
        }

        List(model.results, selection: $selectedChunkId) { item in
          VStack(alignment: .leading, spacing: 6) {
            HStack {
              Text(formatDate(ms: item.start_ts))
                .font(.caption)
                .foregroundStyle(.secondary)

              Text(item.app ?? "UnknownApp")
                .font(.caption)

              if let title = item.window_title, !title.isEmpty {
                Text("— \(title)")
                  .font(.caption)
                  .foregroundStyle(.secondary)
              }
            }

            if let snippet = item.snippet, !snippet.isEmpty {
              Text(snippet)
                .font(.body)
                .lineLimit(3)
            }

            Text("id: \(item.id)")
              .font(.caption2)
              .foregroundStyle(.secondary)
          }
          .padding(.vertical, 6)
          .tag(item.id)
        }
      }
      .padding(16)
    } detail: {
      if let id = selectedChunkId {
        ChunkDetailView(chunkId: id)
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
    .onChange(of: model.results) { _ in
      // 如果当前选中的 id 不在结果里，就清空选择，避免右侧一直显示旧内容。
      if let selectedChunkId, !model.results.contains(where: { $0.id == selectedChunkId }) {
        self.selectedChunkId = nil
      }
    }
  }

  private func searchAndSelectFirstIfNeeded() async {
    await model.search()
    if selectedChunkId == nil, let first = model.results.first {
      selectedChunkId = first.id
    }
  }

  private func formatDate(ms: Int64) -> String {
    let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.string(from: date)
  }
}
