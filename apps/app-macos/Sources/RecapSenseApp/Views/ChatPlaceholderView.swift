import SwiftUI

struct ChatPlaceholderView: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("聊天（占位）")
        .font(.title2)
      Text("后续会在这里接入 RAG/Ask 与对话界面。当前版本先把采集、存储、检索与 MCP 骨架跑通。")
        .foregroundStyle(.secondary)
      Spacer()
    }
    .padding(16)
  }
}

