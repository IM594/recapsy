import SwiftUI

struct SearchResultItem: Decodable, Identifiable {
  let id: String
  let start_ts: Int64
  let end_ts: Int64
  let app: String?
  let window_title: String?
  let snippet: String?
}

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

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        TextField("输入关键词（空表示最近）", text: $model.query)
          .textFieldStyle(.roundedBorder)
          .onSubmit { Task { await model.search() } }

        Stepper("limit \(model.limit)", value: $model.limit, in: 1...50)
          .frame(width: 160)

        Button(model.isLoading ? "搜索中…" : "搜索") {
          Task { await model.search() }
        }
        .disabled(model.isLoading)
        .keyboardShortcut(.return, modifiers: [.command])
      }

      if let error = model.errorMessage {
        Text("错误：\(error)")
          .foregroundStyle(.red)
          .font(.caption)
      }

      List(model.results) { item in
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
      }
    }
    .padding(16)
  }

  private func formatDate(ms: Int64) -> String {
    let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.string(from: date)
  }
}

