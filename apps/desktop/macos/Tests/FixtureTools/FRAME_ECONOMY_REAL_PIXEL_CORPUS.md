# Frame Economy 真实像素语料捕获与审计

## 适用边界

`FrameCorpusCapture` 用一个 purpose-built、borderless `NSWindow` 渲染四个固定场景，再通过 ScreenCaptureKit 和 WindowServer 捕获该窗口。产物覆盖真实窗口合成、颜色和缩放路径，不是 AppKit `cacheDisplay`，也不是旧 synthetic canvas generator 直接填充的像素数组。

ScreenCaptureKit 会返回可共享窗口元数据；工具只比较候选的 `windowID` 和 owner PID，要求它们分别等于测试 `NSWindow.windowNumber` 和 `getpid()`，并且匹配结果必须恰好为一个。像素捕获只使用 `SCContentFilter(desktopIndependentWindow:)` 指向该唯一窗口。工具不读取窗口标题、应用名、bundle ID、剪贴板、文件、环境变量、用户名、时间或其他应用状态，也没有 display capture、其他窗口 fallback、`CGWindowList*`、`CGDisplayCreateImage`、`NSWorkspace` 或 `NSApplication.shared.windows` 路径。

四个场景的全部文字均硬编码为虚构示例。语料证明 purpose-built window 经 WindowServer / ScreenCaptureKit 到 `CGImage` 和 Frame Economy 采样器的行为，但不捕获用户真实桌面内容；完成阈值校准不需要、也不应收集用户数据。

## 固定产物

capture 命令只接受绝对、仓库外、尚不存在的输出目录。它先在内存中渲染并校验全部场景，确认两张 gradient 为 `low-information`、两张虚构 UI 为 `accept` 后，才写入以下文件：

```text
low-information-horizontal-gradient.png
low-information-vertical-gradient.png
accepted-fictional-notes.png
accepted-fictional-tasks.png
manifest.pending-review.json
```

pending manifest 固定声明 `kind=real-pixel-screenshot`、`containsRealUserData=false`、`captureMethod=screen-capture-kit-desktop-independent-window`、`generator=FrameCorpusCapture/2`、`sourceEnvironment=purpose-built-test-window-via-windowserver` 和 `privacyReview=pending-manual-review`，并记录每张 PNG 的 SHA-256、像素尺寸、预期决策和用途。

capture 和 approve 都要求固定四张 PNG 的 SHA-256 互不相同。这个约束与每个场景的预期 Frame Economy 决策一起阻止 WindowServer 仍返回上一场景时把重复帧误标成新 fixture；人工审查仍必须确认每张图片对应 manifest 声明的场景。

人工批准前不会生成 `manifest.json`，因此 `CaptureFrameEconomyRealPixelCalibrationTests` 不会把 pending corpus 当成已审查证据。

## 执行步骤

先只编译工具。该命令不会启动 GUI：

```bash
swift build --package-path apps/desktop/macos --target FrameCorpusCapture
```

获得用户对 GUI 执行和仓库外写入的明确授权后，选择一个新的外部目录并执行 capture：

```bash
CORPUS_DIR="/private/tmp/recapsy-frame-corpus-review-$(date +%Y%m%d-%H%M%S)"
swift run --package-path apps/desktop/macos FrameCorpusCapture \
  capture --output "$CORPUS_DIR"
```

capture 会激活并短暂显示唯一的 purpose-built window。工具不调用系统授权请求 API；负责运行该工具的进程必须已经拥有屏幕录制权限，否则 ScreenCaptureKit 调用会失败，不会回退到其他捕获方式。

随后人工检查目录和全部像素：

```bash
find "$CORPUS_DIR" -maxdepth 1 -type f -print
sips -g pixelWidth -g pixelHeight "$CORPUS_DIR"/*.png
shasum -a 256 "$CORPUS_DIR"/*.png
open "$CORPUS_DIR"/*.png
```

审查者必须逐张确认只存在上述四个 PNG；图片没有菜单栏、Dock、桌面、通知、其他窗口或用户信息；文字只能是 `Atlas Notes`、`Northstar Tasks`、`Example Project`、`Practice Board` 及源码中固定的虚构条目；pending manifest 的文件名、尺寸和 checksum 与实际文件一致。

只有人工和像素审查全部通过后，才执行显式批准：

```bash
swift run --package-path apps/desktop/macos FrameCorpusCapture \
  approve --corpus "$CORPUS_DIR" --confirm-no-user-data
```

approve 会拒绝额外文件、缺失文件、非固定 fixture、checksum 漂移、像素尺寸漂移或 Frame Economy 决策漂移，并只在验证通过后新增 `manifest.json`，将 `privacyReview` 改为 `approved-no-user-data`。它不会修改 PNG 或 pending manifest。

批准后，只把四张 PNG 和正式 `manifest.json` 导入
`Tests/CaptureCoreTests/Fixtures/FrameEconomyReal`；pending manifest 不进入 Git。为避免
SwiftPM resource flattening 与 synthetic corpus 的 `manifest.json` 冲突，正式 manifest
在 fixture 中命名为 `real-pixel-manifest.json`。导入前后必须复核 SHA-256 不变。

最后运行真实像素校准：

```bash
bash apps/desktop/macos/test-capture-core.sh
```

仓库外审核目录只用于 pending review。正式批准的无用户数据 fixture 会进入 Git，使
校准成为默认门禁；审核目录的删除仍属于独立破坏性操作，必须再次确认目录路径和授权后执行。
