import SwiftUI

@MainActor
final class TimelineViewModel: ObservableObject {
  enum Mode: String, CaseIterable, Identifiable {
    case timeline
    case sessions

    var id: String { rawValue }

    var label: String {
      switch self {
      case .timeline:
        return "时间轴"
      case .sessions:
        return "会话（按 App）"
      }
    }
  }

  @Published var date: Date = Date()
  @Published var mode: Mode = .timeline
  /// nil：全部；""：未知应用；其他：按 app 精确匹配。
  @Published var selectedApp: String? = nil
  @Published var isLoading: Bool = false
  @Published var errorMessage: String? = nil
  @Published var timeline: DailyTimelineItem? = nil

  func refresh() async {
    isLoading = true
    errorMessage = nil
    defer { isLoading = false }

    do {
      let client = try AgentHttpClient()
      let day = Self.dayFormatter.string(from: date)
      let loaded = try await client.getDailyTimeline(date: day)
      timeline = loaded

      // “会话模式”需要一个 app 作为锚点：如果用户没选，就默认选用时最高的 app。
      if mode == .sessions, selectedApp == nil {
        selectedApp = loaded.apps.first?.app ?? ""
      }
    } catch {
      errorMessage = String(describing: error)
      timeline = nil
    }
  }

  private static let dayFormatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "zh_CN")
    f.timeZone = TimeZone.current
    f.dateFormat = "yyyy-MM-dd"
    return f
  }()
}

struct TimelineView: View {
  @StateObject private var model = TimelineViewModel()
  @State private var selectedSpanId: String? = nil
  @State private var selectedChunkId: String? = nil

  var body: some View {
    NavigationSplitView {
      VStack(alignment: .leading, spacing: 12) {
        HStack(spacing: 10) {
          DatePicker("日期", selection: $model.date, displayedComponents: [.date])
            .labelsHidden()

          Button(model.isLoading ? "加载中…" : "刷新") {
            Task { await model.refresh() }
          }
          .disabled(model.isLoading)

          Spacer()

          Picker("模式", selection: $model.mode) {
            ForEach(TimelineViewModel.Mode.allCases) { mode in
              Text(mode.label).tag(mode)
            }
          }
          .pickerStyle(.segmented)
          .frame(width: 220)
        }

        if let error = model.errorMessage {
          Text("错误：\(error)")
            .foregroundStyle(.red)
            .font(.caption)
        }

        if let timeline = model.timeline {
          let apps = timeline.apps
          let totalMs = apps.map(\.active_ms).reduce(0, +)

          VStack(alignment: .leading, spacing: 8) {
            HStack {
              Text("当天应用用时（Top）")
                .font(.headline)
              Spacer()
              Text("共 \(apps.count) 个应用")
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            ScrollView(.vertical) {
              VStack(alignment: .leading, spacing: 6) {
                Button {
                  model.selectedApp = nil
                } label: {
                  HStack {
                    Text("全部")
                    Spacer()
                    Text(formatDuration(ms: totalMs))
                      .font(.caption)
                      .foregroundStyle(.secondary)
                  }
                }
                .buttonStyle(.plain)

                ForEach(apps.prefix(12)) { item in
                  let appKey = item.app ?? ""
                  Button {
                    model.selectedApp = appKey
                  } label: {
                    HStack(spacing: 10) {
                      Text(item.app?.isEmpty == false ? item.app! : "UnknownApp")
                        .lineLimit(1)

                      Spacer()

                      Text(formatDuration(ms: item.active_ms))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                  }
                  .buttonStyle(.plain)
                }
              }
              .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 150)
          }

          Divider()

          if model.mode == .timeline {
            TimelineSpanList(
              title: "时间轴片段",
              spans: filteredSpans(timeline: timeline),
              selection: $selectedSpanId
            )
          } else {
            TimelineSessionGroupedSpanList(
              selectedApp: model.selectedApp,
              sessions: filteredSessions(timeline: timeline),
              spans: filteredSpans(timeline: timeline),
              selection: $selectedSpanId
            )
          }
        } else {
          VStack(alignment: .leading, spacing: 8) {
            Text("暂无时间轴数据")
              .font(.headline)
            Text("点击“刷新”从 Agent 拉取当天 frames 并生成时间轴。")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
      }
      .padding(16)
      .onAppear {
        Task { await model.refresh() }
      }
      .onChange(of: model.date) { _ in
        Task { await model.refresh() }
      }
      .onChange(of: model.mode) { _ in
        // 切换到会话模式时，如果没有选 app，就默认选一个。
        if model.mode == .sessions, model.selectedApp == nil {
          model.selectedApp = model.timeline?.apps.first?.app ?? ""
        }
      }
      .onChange(of: selectedSpanId) { newValue in
        guard let timeline = model.timeline else {
          selectedChunkId = nil
          return
        }

        guard let id = newValue else {
          selectedChunkId = nil
          return
        }

        let span = timeline.spans.first { $0.id == id }
        selectedChunkId = span?.sample_chunk_id
      }
    } detail: {
      if let id = selectedChunkId {
        ChunkDetailView(chunkId: id)
      } else {
        VStack(spacing: 8) {
          Text("选择一段时间轴片段")
            .font(.headline)
          Text("如果该片段尚未压实成 chunk，右侧会暂时无法展示正文。")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
  }

  private func filteredSpans(timeline: DailyTimelineItem) -> [TimelineSpanItem] {
    let spans = timeline.spans
    guard let selected = model.selectedApp else { return spans }
    return spans.filter { ($0.app ?? "") == selected }
  }

  private func filteredSessions(timeline: DailyTimelineItem) -> [TimelineSessionItem] {
    let sessions = timeline.sessions
    guard let selected = model.selectedApp else { return sessions }
    return sessions.filter { ($0.app ?? "") == selected }
  }
}

private struct TimelineSpanList: View {
  let title: String
  let spans: [TimelineSpanItem]
  @Binding var selection: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text("\(title)（\(spans.count)）")
          .font(.headline)
        Spacer()
      }

      List(spans, selection: $selection) { span in
        TimelineSpanRow(span: span)
          .tag(span.id)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }
}

private struct TimelineSessionGroupedSpanList: View {
  let selectedApp: String?
  let sessions: [TimelineSessionItem]
  let spans: [TimelineSpanItem]
  @Binding var selection: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text("会话（按 App 合并）")
          .font(.headline)
        Spacer()
      }

      if selectedApp == nil {
        Text("请先选择一个应用。")
          .font(.caption)
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      } else {
        List(selection: $selection) {
          ForEach(sessions) { session in
            Section {
              let spanItems = spans.filter { span in
                span.start_ts >= session.start_ts && span.start_ts <= session.end_ts
              }
              ForEach(spanItems) { span in
                TimelineSpanRow(span: span)
                  .tag(span.id)
              }
            } header: {
              VStack(alignment: .leading, spacing: 2) {
                Text("\(formatTime(ms: session.start_ts))–\(formatTime(ms: session.end_ts)) · \(formatDuration(ms: session.active_ms))")
                  .font(.caption)
                if !session.titles.isEmpty {
                  Text(session.titles.prefix(3).joined(separator: " · "))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
              }
              .textCase(nil)
            }
          }
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }
}

private struct TimelineSpanRow: View {
  let span: TimelineSpanItem

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        Text("\(formatTime(ms: span.start_ts))–\(formatTime(ms: span.end_ts))")
          .font(.caption)
          .foregroundStyle(.secondary)

        Text(span.app?.isEmpty == false ? span.app! : "UnknownApp")
          .font(.caption)

        Spacer()

        Text(formatDuration(ms: span.active_ms))
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      let title = span.window_title_norm.isEmpty ? (span.window_title ?? "") : span.window_title_norm
      if !title.isEmpty {
        Text(title)
          .font(.body)
          .lineLimit(2)
      } else {
        Text("（无窗口标题）")
          .font(.body)
          .foregroundStyle(.secondary)
      }

      HStack(spacing: 10) {
        Text("frames \(span.frame_count)")
          .font(.caption2)
          .foregroundStyle(.secondary)

        if span.chunk_count > 0 {
          Text("chunks \(span.chunk_count)")
            .font(.caption2)
            .foregroundStyle(.secondary)
        }

        if let chunk = span.sample_chunk_id, !chunk.isEmpty {
          Text("sample chunk: \(chunk)")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }
    }
    .padding(.vertical, 6)
  }
}

private func formatTime(ms: Int64) -> String {
  let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
  let f = DateFormatter()
  f.locale = Locale(identifier: "zh_CN")
  f.timeZone = TimeZone.current
  f.dateFormat = "HH:mm"
  return f.string(from: date)
}

private func formatDuration(ms: Int64) -> String {
  let formatter = DateComponentsFormatter()
  formatter.allowedUnits = [.hour, .minute]
  formatter.unitsStyle = .abbreviated
  formatter.zeroFormattingBehavior = [.dropAll]
  formatter.calendar = Calendar.current

  let seconds = Double(ms) / 1000.0
  return formatter.string(from: seconds) ?? "0m"
}
