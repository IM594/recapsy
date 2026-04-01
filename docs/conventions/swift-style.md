# Swift 编码规范

> 适用范围：`apps/desktop/`（SwiftUI）、`apps/collector/`（Swift CLI Daemon）

## 1. 总体原则

- 遵循 [Swift API Design Guidelines](https://www.swift.org/documentation/api-design-guidelines/)
- SwiftUI 优先声明式，UIKit 不使用
- 最低支持 macOS 13 Ventura
- Swift 6+ 语言模式，启用 strict concurrency

---

## 2. 命名约定

### 类型与协议

```swift
// PascalCase — struct, class, enum, protocol
struct ScreenshotMetadata { ... }
class CaptureManager { ... }
enum CaptureState { ... }
protocol ScreenCapturing { ... }

// Protocol 命名：能力用 -ing/-able，角色用名词
protocol ScreenCapturing { ... }     // 能力
protocol Configurable { ... }        // 能力
protocol CaptureDelegate { ... }     // 角色
```

### 变量与函数

```swift
// camelCase
let screenshotCount = 42
func captureScreen() async throws -> ScreenshotData { ... }

// Bool: is/has/should 前缀
var isCapturing: Bool
var hasPermission: Bool
var shouldSkipFrame: Bool

// 函数命名：动词开头，参数标签读起来像自然语言
func save(_ screenshot: ScreenshotData, to directory: URL) throws
func find(screenshotsWith bundleId: String) -> [ScreenshotMetadata]
```

### 常量与静态属性

```swift
// 类型属性用 static let
struct CaptureConfig {
    static let defaultInterval: TimeInterval = 2.0
    static let minDiffRatio: Double = 0.05
    static let maxIdleSkips = 30
}
```

### 文件命名

```
PascalCase.swift           // 与主类型名一致
CaptureManager.swift
ScreenshotMetadata.swift
ContentView.swift

// 扩展文件
CaptureManager+Permissions.swift   // 扩展用 + 分隔
```

---

## 3. 项目结构

### Desktop App

```
apps/desktop/
├── Sources/
│   ├── App/
│   │   ├── RecaplySenseApp.swift      // @main 入口
│   │   └── AppDelegate.swift
│   ├── Views/
│   │   ├── MenuBarView.swift
│   │   ├── SearchView.swift
│   │   ├── TimelineView.swift
│   │   ├── ChatView.swift
│   │   └── SettingsView.swift
│   ├── ViewModels/
│   │   ├── SearchViewModel.swift
│   │   └── TimelineViewModel.swift
│   ├── Services/
│   │   ├── EngineClient.swift         // HTTP + WS client
│   │   └── NotificationService.swift
│   ├── Models/
│   │   └── SharedTypes.swift          // Auto-generated, DO NOT EDIT
│   └── Utils/
│       ├── Extensions/
│       └── Constants.swift
├── Tests/
├── Resources/
│   ├── Assets.xcassets
│   └── Localizable.strings
└── RecaplySense.xcodeproj
```

### Collector Daemon

```
apps/collector/
├── Sources/
│   ├── main.swift                     // CLI entry point
│   ├── Capture/
│   │   ├── ScreenCaptureService.swift
│   │   ├── FrameDiffDetector.swift
│   │   └── WebPCompressor.swift
│   ├── OCR/
│   │   └── VisionOCRService.swift
│   ├── Network/
│   │   ├── EngineAPIClient.swift
│   │   └── OfflineBuffer.swift        // SQLite buffer
│   └── Config/
│       └── CollectorConfig.swift
├── Tests/
└── Package.swift
```

---

## 4. SwiftUI 约定

### View 结构

```swift
struct SearchView: View {
    // 1. Environment & bindings
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var appState: AppState

    // 2. State
    @State private var query = ""
    @State private var results: [SearchResult] = []
    @State private var isSearching = false

    // 3. Dependencies
    @ObservedObject var viewModel: SearchViewModel

    // 4. Body
    var body: some View {
        VStack {
            searchBar
            resultsList
        }
        .task { await viewModel.loadInitial() }
    }

    // 5. Extracted subviews (private computed properties)
    private var searchBar: some View {
        TextField("Search your memory...", text: $query)
            .onSubmit { Task { await viewModel.search(query) } }
    }

    private var resultsList: some View {
        List(viewModel.results) { result in
            SearchResultRow(result: result)
        }
    }
}
```

### ViewModel 模式

```swift
@MainActor
final class SearchViewModel: ObservableObject {
    @Published private(set) var results: [SearchResult] = []
    @Published private(set) var isLoading = false
    @Published var error: AppError?

    private let engineClient: EngineClient

    init(engineClient: EngineClient) {
        self.engineClient = engineClient
    }

    func search(_ query: String) async {
        isLoading = true
        defer { isLoading = false }

        do {
            results = try await engineClient.search(query: query)
        } catch {
            self.error = AppError(from: error)
        }
    }
}
```

### 规则

- View 保持轻量，逻辑放 ViewModel
- 使用 `@MainActor` 标注 ViewModel
- `@Published` 属性用 `private(set)`（只允许 ViewModel 内部修改）
- 复杂子视图提取为独立 struct（当超过 ~30 行）
- 避免在 body 中直接做网络请求

---

## 5. 并发模型

### Swift Concurrency

```swift
// ✅ async/await
func captureScreen() async throws -> ScreenshotData {
    let image = try await screenCaptureService.capture()
    let webp = try await compressor.compress(image, quality: 0.8)
    let ocrText = try await ocrService.recognize(image)
    return ScreenshotData(image: webp, ocrText: ocrText)
}

// ✅ TaskGroup for parallel work
func processFrames(_ frames: [CGImage]) async throws -> [String] {
    try await withThrowingTaskGroup(of: String.self) { group in
        for frame in frames {
            group.addTask { try await self.ocrService.recognize(frame) }
        }
        return try await group.reduce(into: []) { $0.append($1) }
    }
}

// ✅ Actor for shared mutable state
actor CaptureState {
    private var isCapturing = false
    private var consecutiveSkips = 0

    func startCapture() { isCapturing = true }
    func recordSkip() { consecutiveSkips += 1 }
    func resetSkips() { consecutiveSkips = 0 }
    func shouldReduceFrequency() -> Bool { consecutiveSkips >= 30 }
}
```

### 规则

- 使用 `async/await` 替代 completion handlers
- 共享可变状态使用 `actor`
- UI 更新在 `@MainActor`
- 避免 `DispatchQueue` 直接使用（用 Swift Concurrency 替代）

---

## 6. 错误处理

```swift
// 定义模块错误
enum CaptureError: LocalizedError {
    case permissionDenied
    case compressionFailed(underlying: Error)
    case ocrFailed(underlying: Error)
    case engineUnreachable

    var errorDescription: String? {
        switch self {
        case .permissionDenied: "Screen recording permission is required"
        case .compressionFailed: "Failed to compress screenshot"
        case .ocrFailed: "OCR text extraction failed"
        case .engineUnreachable: "Cannot connect to Recaply Engine"
        }
    }
}

// 使用
func capture() async throws -> ScreenshotData {
    guard hasPermission else { throw CaptureError.permissionDenied }

    do {
        let image = try await captureService.capture()
        return try await compress(image)
    } catch let error as CompressionError {
        throw CaptureError.compressionFailed(underlying: error)
    }
}
```

---

## 7. 代码风格

### 格式（swift-format 或 Xcode 默认）

- 缩进：4 spaces
- 行宽：100 字符
- 尾随逗号：推荐（便于 diff）
- Guard early return

```swift
// ✅ Guard early return
func processScreenshot(_ data: ScreenshotData) async throws {
    guard data.fileSize > 0 else { return }
    guard let ocrText = data.ocrText else {
        logger.debug("No OCR text, skipping NER")
        return
    }
    // main logic...
}

// ✅ 尾随闭包
screenshots.filter { $0.isActive }
    .sorted { $0.timestamp > $1.timestamp }
    .prefix(50)
```

### Access Control

```swift
// 默认最小暴露
// public  — 跨模块 API（极少使用，SPM 包之间）
// internal — 默认（模块内可见）
// private  — 文件/类型内部
// fileprivate — 同文件扩展共享（少用）

struct CaptureManager {
    private let config: CaptureConfig       // 外部不可见
    private(set) var state: CaptureState    // 外部只读

    func startCapture() async { ... }       // internal（默认）
}
```

---

## 8. 自动生成类型

`packages/shared/swift/SharedTypes.swift` 由 Zod → JSON Schema → quicktype 自动生成（TDR-015）。

**规则：**

- ⚠️ **DO NOT EDIT** — 文件头有注释标记
- 修改类型请编辑 `packages/shared/src/types/` 中的 Zod schema
- 运行 `bun run generate:swift` 重新生成
- CI 检查生成文件是否与 schema 同步
