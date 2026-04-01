# 国际化策略

> 适用范围：`apps/desktop/`（用户界面）、`packages/engine/`（错误消息、AI 提示）

## 1. 语言支持范围

### 第一阶段（v0.x - v1.0）

| 语言                    | 优先级 | 覆盖范围 |
| ----------------------- | ------ | -------- |
| **简体中文（zh-Hans）** | 主要   | UI 全量  |
| **English（en）**       | 次要   | UI 全量  |

### 未来阶段

根据用户反馈按需扩展（日文、繁体中文等）。

---

## 2. 设计原则

- **系统语言跟随**：默认使用 macOS 系统语言，用户可在设置中切换
- **代码全英文**：变量名、函数名、注释、commit 全部英文
- **用户可见文本全部外部化**：不在代码中硬编码用户可见字符串
- **AI 响应语言跟随用户语言设置**（通过 system prompt 控制）

---

## 3. Desktop App（SwiftUI）

### 使用 Apple 原生 i18n

SwiftUI 内置本地化支持，使用 `String Catalogs`（Xcode 15+）：

```swift
// ✅ 直接使用字符串字面量（SwiftUI 自动查找本地化）
Text("Search your memory...")
Button("Settings") { ... }
Label("Screenshots", systemImage: "photo")

// ✅ 带插值
Text("Found \(count) results")
Text("\(appName) - \(duration) minutes")

// ❌ 不要硬编码
Text("搜索你的记忆...")  // 无法本地化
```

### String Catalog 结构

```
apps/desktop/Resources/
├── Localizable.xcstrings       # 主字符串目录（Xcode 管理）
├── InfoPlist.xcstrings          # Info.plist 本地化
└── (Xcode 自动提取字符串)
```

Xcode 15 的 String Catalogs 自动扫描代码中的字符串字面量，在 `.xcstrings` 文件中管理翻译。

### 命名空间

复杂界面使用 `LocalizedStringKey` 的命名空间前缀：

```swift
// 按功能区分
Text("search.placeholder")     // "Search your memory..."
Text("search.noResults")       // "No results found"
Text("timeline.title")         // "Timeline"
Text("settings.aiProvider")    // "AI Provider"
Text("settings.capture.title") // "Capture Settings"
```

### 复数处理

```swift
// String Catalog 支持 stringsdict 规则
Text("result.count", comment: "Number of search results")
// en: "%lld results" (one: "%lld result")
// zh-Hans: "%lld 个结果"
```

---

## 4. Engine（后端）

### 错误消息

API 错误消息保持**英文**（面向开发者/日志），用户可见的错误描述由 Frontend 本地化：

```typescript
// Engine 返回结构化错误（英文）
{
  "error": {
    "code": "STORAGE_FULL",
    "message": "Disk space exhausted, screenshot storage exceeds limit"
  }
}

// Frontend 根据 error.code 映射本地化消息
// zh-Hans: "磁盘空间不足，截图存储已超出限制"
// en: "Disk space exhausted, screenshot storage exceeds limit"
```

**规则：**

- Engine `error.message` 始终英文
- Frontend 维护 `error.code` → 本地化消息的映射表
- 日志消息始终英文

### AI 对话语言

```typescript
// Agent system prompt 中注入用户语言偏好
const systemPrompt = `
You are Recaply Sense assistant...
Respond in ${userLanguage === "zh-Hans" ? "Chinese (Simplified)" : "English"}.
`;
```

---

## 5. 日期与数字格式化

### 日期

```swift
// ✅ 使用 Foundation 格式化器（自动适配 locale）
let formatter = Date.FormatStyle()
    .year().month().day()
    .hour().minute()
Text(date, format: formatter)

// ✅ 相对时间
Text(date, format: .relative(presentation: .named))
// en: "2 hours ago"
// zh-Hans: "2小时前"
```

```typescript
// Engine 端：时间戳统一 ISO 8601 UTC
// Frontend 端：根据 timezone 和 locale 格式化显示
```

### 数字

```swift
// ✅ 自动 locale 格式化
Text(screenshotCount, format: .number)
// en: "1,234"
// zh-Hans: "1,234"（中文也用逗号分隔）

// 文件大小
Text(fileSize, format: .byteCount(style: .file))
// en: "45 KB"
// zh-Hans: "45 KB"
```

---

## 6. 本地化工作流

### 添加新字符串

1. 在 SwiftUI 代码中使用字符串字面量
2. Build 项目 → Xcode 自动将新字符串添加到 `.xcstrings`
3. 在 Xcode String Catalog 编辑器中添加中文翻译
4. 提交 `.xcstrings` 文件

### 翻译维护

| 规则            | 说明                                            |
| --------------- | ----------------------------------------------- |
| 新增字符串      | 同一 PR 中必须包含中英文翻译                    |
| 修改字符串      | 同步更新所有语言                                |
| 未翻译 fallback | 默认显示英文（Swift 原生行为）                  |
| 翻译审查        | 使用 Xcode 的 Export Localizations 功能批量审查 |

---

## 7. 不本地化的内容

| 内容                              | 理由             |
| --------------------------------- | ---------------- |
| 应用名 "Recaply Sense"            | 品牌名，不翻译   |
| 技术术语（OCR、LLM、Embedding）   | 通用术语         |
| API 路径和参数                    | 面向开发者       |
| 日志消息                          | 面向开发者       |
| 配置项 key                        | 内部标识         |
| Entity.name（如应用名 "VS Code"） | 用户数据原样保留 |
