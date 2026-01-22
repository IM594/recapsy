import AppKit
import SwiftUI

@MainActor
final class DailySummaryViewModel: ObservableObject {
  @Published var date: Date = Date()
  @Published var isLoading: Bool = false
  @Published var errorMessage: String? = nil
  @Published var summary: DailySummaryItem? = nil

  func load() async {
    isLoading = true
    errorMessage = nil
    summary = nil
    defer { isLoading = false }

    do {
      let client = try AgentHttpClient()
      let dateStr = formatLocalDate(date)
      summary = try await client.getDailySummary(date: dateStr)
    } catch {
      errorMessage = String(describing: error)
    }
  }

  private func formatLocalDate(_ date: Date) -> String {
    let calendar = Calendar.current
    let year = calendar.component(.year, from: date)
    let month = calendar.component(.month, from: date)
    let day = calendar.component(.day, from: date)
    return String(format: "%04d-%02d-%02d", year, month, day)
  }
}

struct DailySummaryView: View {
  @StateObject private var model = DailySummaryViewModel()

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        DatePicker("日期", selection: $model.date, displayedComponents: [.date])
          .datePickerStyle(.compact)

        Button(model.isLoading ? "加载中…" : "刷新") {
          Task { await model.load() }
        }
        .disabled(model.isLoading)

        Spacer()
      }

      if let error = model.errorMessage {
        Text("错误：\(error)")
          .foregroundStyle(.red)
          .font(.caption)
      }

      Group {
        if model.isLoading {
          VStack(spacing: 10) {
            ProgressView()
            Text("正在生成/加载日总结…")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let summary = model.summary {
          SelectableTextView(
            text: summary.summary,
            font: .monospacedSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
          )
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .background(Color(nsColor: .textBackgroundColor))
          .overlay(
            RoundedRectangle(cornerRadius: 8)
              .stroke(Color.gray.opacity(0.25), lineWidth: 1)
          )
          .clipShape(RoundedRectangle(cornerRadius: 8))
        } else {
          VStack(alignment: .leading, spacing: 8) {
            Text("暂无日总结")
              .font(.headline)
            Text("这一天可能还没有产生任何 chunks（或者你当日没有活动数据）。")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
          .padding(.top, 6)
        }
      }
    }
    .padding(16)
    .onAppear { Task { await model.load() } }
    .onChange(of: model.date) { _ in
      Task { await model.load() }
    }
  }
}
