import AppKit
import SwiftUI

/// 用于展示大段文本的可选择视图。
///
/// 背景：
/// - SwiftUI 的 `Text` 在开启 `.textSelection(.enabled)` 且文本很长时，容易出现明显卡顿（布局与选择开销较大）。
/// - 这里用 `NSTextView` 做承载：只读、可选中、可滚动，适合日志 / OCR 长文本 / chunk 正文。
struct SelectableTextView: NSViewRepresentable {
  let text: String
  var font: NSFont = .monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
  var textColor: NSColor = .textColor
  var usesFindBar: Bool = true

  func makeNSView(context: Context) -> NSScrollView {
    // 用系统自带的“可滚动文本视图”初始化，能避免 documentView 尺寸为 0 导致的空白问题。
    let scrollView = NSTextView.scrollableTextView()
    scrollView.hasVerticalScroller = true
    scrollView.hasHorizontalScroller = false
    scrollView.autohidesScrollers = true
    scrollView.drawsBackground = false

    guard let textView = scrollView.documentView as? NSTextView else {
      return scrollView
    }

    textView.isEditable = false
    textView.isSelectable = true
    textView.drawsBackground = false
    textView.font = font
    textView.textColor = textColor
    textView.string = text
    textView.textContainerInset = NSSize(width: 10, height: 8)
    textView.allowsUndo = false
    textView.isRichText = false
    textView.importsGraphics = false

    // 关闭“智能替换”等文本特性，避免日志/代码块被系统改写。
    textView.isAutomaticQuoteSubstitutionEnabled = false
    textView.isAutomaticDashSubstitutionEnabled = false
    textView.isAutomaticTextReplacementEnabled = false
    textView.isAutomaticSpellingCorrectionEnabled = false

    // 允许 Command+F 查找（对日志排障很实用）。
    textView.usesFindBar = usesFindBar

    // 垂直滚动 + 自动换行（不使用横向滚动条）。
    textView.isVerticallyResizable = true
    textView.isHorizontallyResizable = false
    textView.textContainer?.widthTracksTextView = true
    textView.textContainer?.containerSize = NSSize(width: scrollView.contentSize.width, height: .greatestFiniteMagnitude)

    return scrollView
  }

  func updateNSView(_ nsView: NSScrollView, context: Context) {
    guard let textView = nsView.documentView as? NSTextView else { return }
    if textView.font != font {
      textView.font = font
    }
    if textView.textColor != textColor {
      textView.textColor = textColor
    }
    if textView.string != text {
      textView.string = text
    }
  }
}
