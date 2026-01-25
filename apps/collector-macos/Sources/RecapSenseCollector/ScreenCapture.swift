import CoreGraphics
import Foundation

enum ScreenCaptureSource: String {
  case frontmostWindow = "frontmost-window"
  case windowBoundsCrop = "window-bounds-crop"
  case screenFallback = "screen-fallback"
}

private func normalizeWindowText(_ text: String?) -> String {
  (text ?? "")
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased()
}

private func isSystemNoiseWindow(ownerName: String?, windowName: String?) -> Bool {
  // 说明：
  // - CGWindowList 里会出现一些“系统 UI”窗口（例如 Dock/控制中心），它们经常不是用户真正关注的内容。
  // - 更关键的是：当我们走 `window-bounds-crop` 时，如果把这些窗口当作“前台窗口元数据”，
  //   很容易出现 `app=程序坞(Dock)` 但 OCR 内容来自 Warp/Chrome 的错配。
  // - 因此这里做一个保守的噪声过滤：跳过这些系统窗口，优先选择真实的 App 窗口。
  let owner = normalizeWindowText(ownerName)
  let title = normalizeWindowText(windowName)

  // Dock（英文/中文）
  if owner == "dock" || owner == "程序坞" { return true }
  if title == "dock" || title == "程序坞" { return true }

  // 其他常见系统 UI（尽量保守：只过滤明确的系统组件）
  let systemOwners: Set<String> = [
    "windowserver",
    "window server",
    "systemuiserver",
    "controlcenter",
    "控制中心",
    "notificationcenter",
    "通知中心",
    "spotlight",
    "聚焦",
    "loginwindow",
  ]
  if systemOwners.contains(owner) { return true }
  return false
}

struct ScreenCaptureMetadata {
  /// 截到的“窗口所属应用名”（来自 CGWindowList）。
  let appName: String?
  /// 截到的“窗口标题”（来自 CGWindowList 的 kCGWindowName；可能为空）。
  let windowTitle: String?
  let pid: pid_t?
  let windowID: CGWindowID?
  let bounds: CGRect?
}

struct ScreenCaptureResult {
  let image: CGImage
  let source: ScreenCaptureSource
  let metadata: ScreenCaptureMetadata
}

private struct WindowCandidate {
  let windowID: CGWindowID
  let ownerPid: pid_t
  let ownerName: String?
  let bounds: CGRect
  let windowName: String?
  let layer: Int
  let alpha: Double?
  let sharingState: Int?
}

enum ScreenCaptureDecision {
  case captured(ScreenCaptureResult)
  case skippedExcluded(appName: String)
  case failed
}

func captureFrontmostWindowForOCR(
  excludedApps: [String],
  log: (String) -> Void
) -> ScreenCaptureDecision {
  guard let candidate = findFrontmostOnScreenWindow() else {
    return .failed
  }

  if let ownerName = candidate.ownerName, isExcludedApp(ownerName, excludedApps: excludedApps) {
    log("命中应用黑名单（跳过采集）：\(ownerName)")
    return .skippedExcluded(appName: ownerName)
  }

    let options: CGWindowImageOption = [.bestResolution, .boundsIgnoreFraming]

    if let image = CGWindowListCreateImage(.null, .optionIncludingWindow, candidate.windowID, options) {
      log(
        "截图来源：前台窗口（windowID=\(candidate.windowID) owner=\(candidate.ownerName ?? "-") name=\(candidate.windowName ?? "-")）"
      )
      return .captured(
        ScreenCaptureResult(
          image: image,
          source: .frontmostWindow,
          metadata: toMetadata(candidate)
        )
      )
    }

    if let image = CGWindowListCreateImage(candidate.bounds, .optionIncludingWindow, candidate.windowID, options) {
      log("截图来源：前台窗口（bounds 降级）（windowID=\(candidate.windowID)）")
      return .captured(
        ScreenCaptureResult(
          image: image,
          source: .frontmostWindow,
          metadata: toMetadata(candidate)
        )
      )
    }

    // 某些应用/窗口（例如部分 GPU 渲染窗口）可能无法被“按 windowID”截到，但我们仍然可以：
    // 直接按 window bounds 去截取屏幕对应区域（合成后的画面），这样至少能显著减少“全屏噪声”。
    // 关键修复：
    // - 这里的“bounds 裁剪”截的是屏幕合成后的画面，窗口被覆盖/前台切换时很容易出现：
    //   header(app/title) 与 OCR 内容“错配/互换”。
    // - 因此我们在裁剪前，用一个点（候选窗口中心点）反查“此处真正的最上层窗口”，
    //   若发现不一致，则以“实际最上层窗口”作为 metadata 的真值，并用它的 bounds 进行裁剪。
    let probePoint = CGPoint(x: candidate.bounds.midX, y: candidate.bounds.midY)
    let topAtProbe = findTopmostOnScreenWindow(containing: probePoint)
    let cropTarget = chooseCropTarget(original: candidate, top: topAtProbe)

    if let ownerName = cropTarget.ownerName, isExcludedApp(ownerName, excludedApps: excludedApps) {
      log("窗口裁剪命中应用黑名单（跳过采集）：\(ownerName)")
      return .skippedExcluded(appName: ownerName)
    }

    let cropAlphaStr = cropTarget.alpha.map { String(format: "%.3f", $0) } ?? "-"
    let cropSharingStr = cropTarget.sharingState.map { String($0) } ?? "-"

    if let image = CGWindowListCreateImage(cropTarget.bounds, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution]) {
      if cropTarget.windowID != candidate.windowID || cropTarget.ownerPid != candidate.ownerPid {
        log(
          "窗口裁剪元数据矫正：\(candidate.ownerName ?? "-")/\(candidate.windowName ?? "-") -> \(cropTarget.ownerName ?? "-")/\(cropTarget.windowName ?? "-")"
        )
      }

      log(
        "截图来源：窗口区域裁剪（windowID=\(cropTarget.windowID) layer=\(cropTarget.layer) alpha=\(cropAlphaStr) sharing=\(cropSharingStr)）"
      )

      return .captured(
        ScreenCaptureResult(
          image: image,
          source: .windowBoundsCrop,
          metadata: toMetadata(cropTarget)
        )
      )
    }

    let candidateAlphaStr = candidate.alpha.map { String(format: "%.3f", $0) } ?? "-"
    let candidateSharingStr = candidate.sharingState.map { String($0) } ?? "-"
    log(
      "前台窗口截图失败（windowID=\(candidate.windowID) layer=\(candidate.layer) alpha=\(candidateAlphaStr) sharing=\(candidateSharingStr)），将降级为全屏截图。"
    )

  // 降级：全屏截图（保持兼容性，避免某些窗口无法截图导致完全无数据）
  if let fallback = captureFullScreenForOCR(log: log) {
    return .captured(fallback)
  }

  return .failed
}

func captureFullScreenForOCR(log: (String) -> Void) -> ScreenCaptureResult? {
  if let image = CGWindowListCreateImage(.infinite, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution]) {
    log("截图来源：全屏（CGWindowListCreateImage）")
    return ScreenCaptureResult(
      image: image,
      source: .screenFallback,
      metadata: ScreenCaptureMetadata(appName: nil, windowTitle: nil, pid: nil, windowID: nil, bounds: nil)
    )
  }

  if let image = CGDisplayCreateImage(CGMainDisplayID()) {
    log("截图来源：主屏（CGDisplayCreateImage）")
    return ScreenCaptureResult(
      image: image,
      source: .screenFallback,
      metadata: ScreenCaptureMetadata(appName: nil, windowTitle: nil, pid: nil, windowID: nil, bounds: nil)
    )
  }

  return nil
}

private func findFrontmostOnScreenWindow() -> WindowCandidate? {
  let listOptions: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  guard
    let rawList = CGWindowListCopyWindowInfo(listOptions, kCGNullWindowID),
    let list = rawList as? [[String: Any]]
  else {
    return nil
  }

  // CGWindowListCopyWindowInfo 的返回顺序是“由前到后”（front-to-back）。
  // 我们按顺序选择一个足够大的 layer=0 窗口，作为“当前用户真正看到的前台窗口”。
  for item in list {
    guard let candidate = parseWindowCandidate(item) else { continue }
    if isSystemNoiseWindow(ownerName: candidate.ownerName, windowName: candidate.windowName) {
      continue
    }
    // layer=0 是普通应用窗口；更高 layer 往往是菜单/悬浮层/系统 UI（噪声更大）。
    if candidate.layer != 0 { continue }
    return candidate
  }

  // 兜底：如果找不到 layer=0，就退回到任意满足条件的窗口（至少能得到一张图）。
  for item in list {
    guard let candidate = parseWindowCandidate(item) else { continue }
    if isSystemNoiseWindow(ownerName: candidate.ownerName, windowName: candidate.windowName) {
      continue
    }
    return candidate
  }

  return nil
}

private extension CGRect {
  var area: CGFloat { width * height }
}

private func parseWindowCandidate(_ item: [String: Any]) -> WindowCandidate? {
  guard let ownerPid = item[kCGWindowOwnerPID as String] as? Int else { return nil }
  guard let windowNumber = item[kCGWindowNumber as String] as? UInt32 else { return nil }

  let bounds: CGRect
  if let boundsDict = item[kCGWindowBounds as String] as? NSDictionary,
     let rect = CGRect(dictionaryRepresentation: boundsDict)
  {
    bounds = rect
  } else {
    return nil
  }

  // 经验阈值：过小的窗口通常只有按钮/提示，对 OCR 产出噪声更大。
  if bounds.width < 180 || bounds.height < 120 { return nil }

  let ownerName = item[kCGWindowOwnerName as String] as? String
  let windowName = item[kCGWindowName as String] as? String

  let layer = item[kCGWindowLayer as String] as? Int ?? 0
  let alpha = item[kCGWindowAlpha as String] as? Double
  let sharingState = item[kCGWindowSharingState as String] as? Int

  // alpha=0 的窗口通常不可见/不适合 OCR
  if let alpha, alpha <= 0.001 { return nil }

  return WindowCandidate(
    windowID: windowNumber,
    ownerPid: pid_t(ownerPid),
    ownerName: ownerName,
    bounds: bounds,
    windowName: windowName,
    layer: layer,
    alpha: alpha,
    sharingState: sharingState
  )
}

private func findTopmostOnScreenWindow(containing point: CGPoint) -> WindowCandidate? {
  let listOptions: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  guard
    let rawList = CGWindowListCopyWindowInfo(listOptions, kCGNullWindowID),
    let list = rawList as? [[String: Any]]
  else {
    return nil
  }

  for item in list {
    guard let candidate = parseWindowCandidate(item) else { continue }
    if isSystemNoiseWindow(ownerName: candidate.ownerName, windowName: candidate.windowName) {
      continue
    }
    if candidate.bounds.contains(point) {
      return candidate
    }
  }

  return nil
}

private func chooseCropTarget(original: WindowCandidate, top: WindowCandidate?) -> WindowCandidate {
  guard let top else { return original }

  // 避免误把“很小的悬浮窗/菜单”当成主窗口。
  // 只有当 topWindow 面积足够大时，才认为需要切换到它。
  let minArea = original.bounds.area * 0.25
  if top.bounds.area < minArea { return original }
  return top
}

private func toMetadata(_ candidate: WindowCandidate) -> ScreenCaptureMetadata {
  ScreenCaptureMetadata(
    appName: candidate.ownerName,
    windowTitle: candidate.windowName,
    pid: candidate.ownerPid,
    windowID: candidate.windowID,
    bounds: candidate.bounds
  )
}

private func normalizeForExcludedAppMatch(_ value: String) -> String {
  let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  if trimmed.isEmpty { return "" }

  let replaced = trimmed
    .replacingOccurrences(of: "_", with: " ")
    .replacingOccurrences(of: "-", with: " ")

  return replaced.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func isExcludedApp(_ appName: String, excludedApps: [String]) -> Bool {
  if excludedApps.isEmpty { return false }
  let normalized = normalizeForExcludedAppMatch(appName)
  if normalized.isEmpty { return false }

  return excludedApps.contains { item in
    let rule = normalizeForExcludedAppMatch(item)
    if rule.isEmpty { return false }
    if rule == normalized { return true }
    if rule.count >= 3, normalized.contains(rule) { return true }
    return false
  }
}
