import SwiftUI

struct MainWindowView: View {
  var body: some View {
    TabView {
      SearchView()
        .tabItem { Label("搜索", systemImage: "magnifyingglass") }

      LogsView()
        .tabItem { Label("日志", systemImage: "doc.text") }

      ChatPlaceholderView()
        .tabItem { Label("聊天（占位）", systemImage: "bubble.left.and.bubble.right") }
    }
    .frame(minWidth: 760, minHeight: 520)
  }
}

