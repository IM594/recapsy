import AppKit
import CoreGraphics
import Darwin
import Foundation

struct CollectorConfig {
  let intervalSeconds: Double
  let dedupeThreshold: Int
  let captureMode: CaptureMode
  let ocrLevel: OCRLevel
  let ocrLanguages: [String]
  let ocrLogEnabled: Bool
  let thumbnailEnabled: Bool
  let thumbnailMaxWidth: Int
  let excludedApps: [String]
  let dryRun: Bool
  let once: Bool
  let verbose: Bool
}

enum CaptureMode: String {
  /// 优先截取“前台窗口”区域（噪声更少，适合 OCR）。
  case window
  /// 直接截取全屏（兼容性最好，但 UI 噪声更大）。
  case screen
}

struct Logger {
  let verbose: Bool

  private func timestamp() -> String {
    // 使用本地时区（用户在中国杭州），便于直接对应“我当时在干什么”。
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "zh_CN")
    formatter.timeZone = TimeZone.current
    formatter.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
    return formatter.string(from: Date())
  }

  func info(_ message: String) {
    print("[\(timestamp())] [collector] \(message)")
    fflush(stdout)
  }

  func debug(_ message: String) {
    guard verbose else { return }
    print("[\(timestamp())] [collector][debug] \(message)")
    fflush(stdout)
  }

  func warn(_ message: String) {
    print("[\(timestamp())] [collector][warn] \(message)")
    fflush(stdout)
  }
}

final class OneTimeNotice {
  private var seen: Set<String> = []
  private let lock = NSLock()

  func once(key: String, _ action: () -> Void) {
    lock.lock()
    defer { lock.unlock() }
    if seen.contains(key) { return }
    seen.insert(key)
    action()
  }
}

actor DedupeState {
  var lastKey: String? = nil
  var lastHash: ImageHash? = nil
  var lastOcrText: String? = nil

  func shouldSkip(key: String, hash: ImageHash, threshold: Int) -> Bool {
    guard threshold >= 0 else { return false }
    guard let lastKey, lastKey == key else { return false }
    guard let lastHash else { return false }
    guard let distance = lastHash.hammingDistance(to: hash) else { return false }
    return distance <= threshold
  }

  func updateAccepted(key: String, hash: ImageHash, ocrText: String) {
    lastKey = key
    lastHash = hash
    lastOcrText = ocrText
  }

  func isSameOcrText(key: String, text: String) -> Bool {
    guard let lastKey, lastKey == key else { return false }
    guard let lastOcrText else { return false }
    return lastOcrText == text
  }
}

private func shouldExitBecauseParentMissing() -> Bool {
  let env = ProcessInfo.processInfo.environment
  guard let raw = env["RECAPSENSE_PARENT_PID"], !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
    return false
  }
  guard let parentPid = Int32(raw.trimmingCharacters(in: .whitespacesAndNewlines)), parentPid > 1 else {
    return false
  }

  // kill(pid, 0)：
  // - 0 表示不发送信号，仅用于检测进程是否存在/是否有权限
  // - ESRCH 表示进程不存在
  let rc = kill(parentPid, 0)
  if rc == 0 { return false }
  if errno == ESRCH { return true }
  // EPERM：存在但没权限，视为“父进程还在”
  return false
}

@main
struct RecapSenseCollectorMain {
  static func main() async {
    let config = parseConfig(args: CommandLine.arguments)
    let logger = Logger(verbose: config.verbose)
    let notices = OneTimeNotice()

    let sep = String(repeating: "=", count: 78)
    logger.info(sep)
    logger.info("session start（pid=\(getpid())）")
    logger.info("argv：\(CommandLine.arguments.joined(separator: " "))")
    logger.info(sep)

    do {
      let dataDir = resolveDataDir()
      let instanceLock = try CollectorInstanceLock(
        lockFile: dataDir.appendingPathComponent("run/collector.lock")
      )
      defer { _ = instanceLock }

      let token = try loadToken(dataDir: dataDir)
      let agentURL = try resolveAgentBaseURL()

      let client = AgentClient(
        config: AgentClientConfig(
          baseURL: agentURL,
          token: token,
          timeoutSeconds: 15
        )
      )

      logger.info("启动成功（macOS 13+）")
      logger.info("Agent：\(agentURL.absoluteString)")
      logger.info("数据目录：\(dataDir.path)")
      logger.info("采集间隔：\(config.intervalSeconds)s，去重阈值：\(config.dedupeThreshold)")
      logger.info("截图范围：\(config.captureMode.rawValue)（window=前台窗口优先；screen=全屏）")
      logger.info("OCR：level=\(config.ocrLevel.rawValue)，languages=\(config.ocrLanguages.joined(separator: ","))")
      logger.info("缩略图：enabled=\(config.thumbnailEnabled)，maxWidth=\(config.thumbnailMaxWidth)px")
      logger.info("OCR 全文日志：\(config.ocrLogEnabled ? "enabled" : "disabled")（调试用途，文件：logs/collector-ocr.log）")
      if config.excludedApps.isEmpty {
        logger.info("应用黑名单（Bundle ID）：无")
      } else {
        logger.info("应用黑名单（Bundle ID）：\(config.excludedApps.joined(separator: ", "))")
      }
      if config.dryRun {
        logger.warn("当前为 dry-run：不会写入 Agent（仅本地打印摘要）")
      }

      // 屏幕录制权限提示：
      // - macOS 的“屏幕录制”权限非常容易让人困惑：你以为是给终端授权，但实际采集进程可能是被别的 App 拉起的。
      // - 这里提前做一次 preflight，并尽力给出更明确的提示。
      let launchSource = ProcessInfo.processInfo.environment["RECAPSENSE_LAUNCH_SOURCE"] ?? ""
      let executablePath = CommandLine.arguments.first ?? "recapsense-collector"
      if !CGPreflightScreenCaptureAccess() {
        if launchSource == "app-macos" {
          logger.warn(
            "当前未获得“屏幕录制”权限：你是从 RecapSense 菜单栏 App 启动的采集。请在 系统设置 → 隐私与安全性 → 屏幕录制 中给以下程序授权：\(executablePath)。"
          )
        } else {
          logger.warn(
            "当前未获得“屏幕录制”权限：请在 系统设置 → 隐私与安全性 → 屏幕录制 中给 recapsense-collector（或你运行它的终端）授权。可执行文件：\(executablePath)"
          )
        }
        _ = CGRequestScreenCaptureAccess()
      }

      let stop = StopController()
      await stop.installSignalHandlers(log: logger.info)

      let dedupeState = DedupeState()
      let paths = CollectorPaths(dataDir: dataDir)
      let ocrLogsDir = dataDir.appendingPathComponent("logs", isDirectory: true)
      let ocrDebugLog: OcrDebugLog? = {
        guard config.ocrLogEnabled else { return nil }
        do {
          // 体量上限：50MB（超过会轮转为 `.1`）
          return try OcrDebugLog(logsDir: ocrLogsDir, maxBytes: 50_000_000)
        } catch {
          logger.warn("OCR 全文日志初始化失败：\(String(describing: error))")
          return nil
        }
      }()

      var tickIndex = 0
      while !(await stop.shouldStop()) {
        if shouldExitBecauseParentMissing() {
          logger.warn("父进程已退出（RECAPSENSE_PARENT_PID 不存在），collector 自动退出。")
          break
        }

        tickIndex += 1

        do {
          let context = await MainActor.run {
            readFrontmostAppContext(log: { message in
              notices.once(key: "ax-permission") { logger.warn(message) }
            })
          }

          var appName = context.appName
          var appBundleId = context.bundleId
          var windowTitle = context.windowTitle
          var captureResult: ScreenCaptureResult? = nil

          // 黑名单第一道闸门：按“前台应用 Bundle ID”（NSWorkspace）过滤。
          if let appBundleId, isExcludedAppBundleId(appBundleId, excludedBundleIds: config.excludedApps) {
            logger.debug("命中应用黑名单（跳过采集）：\(appName ?? appBundleId)")
            await sleepSeconds(config.intervalSeconds)
            continue
          }

          if config.captureMode == .window {
            let decision = captureFrontmostWindowForOCR(
              log: { message in logger.debug(message) }
            )

            switch decision {
            case .failed:
              // “前台窗口”失败：降级为全屏（尽量保证有数据）。
              captureResult = captureFullScreenForOCR(log: { message in logger.debug(message) })
            case .captured(let result):
              captureResult = result
              let capturedPid = result.metadata.pid

              if let capturedPid {
                let identity = await MainActor.run { resolveRunningAppIdentity(pid: capturedPid) }
                if let bundleId = identity.bundleId {
                  appBundleId = bundleId
                } else if capturedPid != context.pid {
                  appBundleId = nil
                }

                if let name = identity.name {
                  appName = name
                } else if let capturedAppName = result.metadata.appName,
                          !capturedAppName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                {
                  appName = capturedAppName
                } else if capturedPid != context.pid {
                  // 元数据来自 CGWindowList，但前台 app 的 context 可能滞后；避免错贴。
                  appName = nil
                }
              }

              if let capturedWindowName = result.metadata.windowTitle,
                 !capturedWindowName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              {
                windowTitle = capturedWindowName
              } else if let capturedPid, capturedPid != context.pid {
                windowTitle = nil
              }

              // 额外：如果有辅助功能权限，尝试用 AX 拿到“聚焦窗口标题”，通常更准确。
              if let capturedPid {
                let axTitle = await MainActor.run {
                  readFocusedWindowTitle(pid: capturedPid, log: { message in
                    notices.once(key: "ax-permission") { logger.warn(message) }
                  })
                }
                if let axTitle, !axTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                  windowTitle = axTitle
                }
              }
            }
          } else {
            captureResult = captureFullScreenForOCR(log: { message in logger.debug(message) })
          }

          // 黑名单第二道闸门：按“最终 appBundleId”（可能来自 window pid）再过滤一次。
          if let appBundleId, isExcludedAppBundleId(appBundleId, excludedBundleIds: config.excludedApps) {
            logger.debug("命中应用黑名单（跳过采集）：\(appName ?? appBundleId)")
            await sleepSeconds(config.intervalSeconds)
            continue
          }

          let keyApp = appBundleId ?? appName ?? ""
          let key = "\(keyApp)\n\(windowTitle ?? "")"

          guard let screenshot = captureResult?.image else {
            notices.once(key: "screen-recording") {
              if launchSource == "app-macos" {
                logger.warn(
                  "无法截屏：当前采集进程缺少“屏幕录制”权限。你是从 RecapSense 菜单栏 App 启动的采集，请在 系统设置 → 隐私与安全性 → 屏幕录制 中给以下程序授权：\(executablePath)。"
                )
              } else {
                logger.warn(
                  "无法截屏：请在 系统设置 → 隐私与安全性 → 屏幕录制 中给 recapsense-collector（或你运行它的终端）授权。可执行文件：\(executablePath)"
                )
              }
            }
            await sleepSeconds(config.intervalSeconds)
            continue
          }

          if config.captureMode == .window, captureResult?.source == .screenFallback {
            notices.once(key: "capture-fallback") {
              logger.warn(
                "本次截图降级为全屏：前台窗口/窗口裁剪截图失败或不可用（这会显著增加 OCR 噪声）。如持续出现，可尝试 `--capture-mode screen` 验证兼容性。"
              )
            }
          }

          let hash = try computeDHash64(from: screenshot)
          if await dedupeState.shouldSkip(key: key, hash: hash, threshold: config.dedupeThreshold) {
            logger.debug("去重命中（跳过 OCR）：app=\(appName ?? "Unknown") hash=\(hash.stringValue)")
            await sleepSeconds(config.intervalSeconds)
            continue
          }

          // OCR：默认 fast，但在明显低质量时自动升级跑一次 accurate（减少碎片/乱码）。
          var ocrText = try recognizeText(from: screenshot, level: config.ocrLevel, languages: config.ocrLanguages)
          var ocrPass = config.ocrLevel.rawValue

          if config.ocrLevel == .fast {
            let fastQ = evaluateOCRTextQuality(ocrText)
            if shouldUpgradeFastOCR(fastQ) {
              let accurateText = try recognizeText(from: screenshot, level: .accurate, languages: config.ocrLanguages)
              let accurateQ = evaluateOCRTextQuality(accurateText)

              // 选择更好的那次输出（评分更高者）。相等时优先 accurate（通常更稳定）。
              if accurateQ.score >= fastQ.score {
                ocrText = accurateText
                ocrPass = "fast→accurate"
              } else {
                ocrPass = "fast（kept）"
              }

              logger.debug(
                "OCR 自动二次识别：fast(score=\(Int(fastQ.score)) good=\(fastQ.goodChars) weird=\(fastQ.weirdChars)) vs accurate(score=\(Int(accurateQ.score)) good=\(accurateQ.goodChars) weird=\(accurateQ.weirdChars)) chosen=\(ocrPass)"
              )
            }
          }
          if ocrText.isEmpty {
            logger.debug("OCR 为空（跳过写入）")
            await sleepSeconds(config.intervalSeconds)
            continue
          }

          if await dedupeState.isSameOcrText(key: key, text: ocrText) {
            logger.debug("OCR 文本未变化（跳过写入）")
            // 这里更新 hash，避免重复做 OCR（下一次更容易命中去重阈值）。
            await dedupeState.updateAccepted(key: key, hash: hash, ocrText: ocrText)
            await sleepSeconds(config.intervalSeconds)
            continue
          }

          let now = Date()
          let tsMs = Int64(now.timeIntervalSince1970 * 1000)

          if let ocrDebugLog {
            let localTs = formatLocalTimestamp(now)
            let lines = ocrText.split(separator: "\n").count
            let header =
              "[\(localTs)] tsMs=\(tsMs) app=\(appName ?? "Unknown") bundle=\(appBundleId ?? "-") title=\(windowTitle ?? "-") capture=\(captureResult?.source.rawValue ?? "-") ocr=\(ocrPass) phash=\(hash.stringValue) ocrLines=\(lines) ocrChars=\(ocrText.count)\n"
            let body =
              "----- OCR BEGIN -----\n\(ocrText)\n----- OCR END -----\n\n"
            ocrDebugLog.append(header + body)
          }

          var thumbnailPath: String? = nil
          if config.thumbnailEnabled {
            let localDate = formatLocalDate(now)
            let filename = "\(tsMs)_\(hash.stringValue.replacingOccurrences(of: ":", with: "_")).jpg"
            let rel = paths.thumbnailRelativePath(date: localDate, filename: filename)
            let abs = paths.thumbnailAbsoluteURL(relativePath: rel)

            try FileManager.default.createDirectory(
              at: abs.deletingLastPathComponent(),
              withIntermediateDirectories: true
            )

            let thumb = resizeImage(screenshot, maxWidth: config.thumbnailMaxWidth)
            try writeJpeg(image: thumb, to: abs, quality: 0.70)
            thumbnailPath = rel
          }

          let payload = IngestFrameRequestBody(
            ts: tsMs,
            app: appName,
            appBundleId: appBundleId,
            windowTitle: windowTitle,
            ocrText: ocrText,
            phash: hash.stringValue,
            screenshotPath: nil,
            thumbnailPath: thumbnailPath
          )

          if config.dryRun {
            let preview = String(ocrText.prefix(220))
            let lines = ocrText.split(separator: "\n").count
            logger.info(
              "dry-run frame：app=\(appName ?? "Unknown") title=\(windowTitle ?? "-") capture=\(captureResult?.source.rawValue ?? "-") ocr=\(ocrPass) ocrLines=\(lines) ocrChars=\(ocrText.count) text=\(preview)"
            )
          } else {
            let result = try await client.ingestFrame(payload)
            if result.skipped {
              if let thumbnailPath {
                let abs = paths.thumbnailAbsoluteURL(relativePath: thumbnailPath)
                try? FileManager.default.removeItem(at: abs)
              }

              let reason = result.reason ?? "unknown"
              notices.once(key: "agent-skipped:\(reason):\(appName ?? "Unknown")") {
                logger.warn("Agent 兜底丢弃 frame（reason=\(reason)，app=\(appName ?? "Unknown")）")
              }
            } else {
              let id = result.id
              let lines = ocrText.split(separator: "\n").count
              var message =
                "写入 frame 成功：id=\(id.map(String.init) ?? "?") app=\(appName ?? "Unknown") capture=\(captureResult?.source.rawValue ?? "-") ocr=\(ocrPass) ocrLines=\(lines) ocrChars=\(ocrText.count)"
              if config.verbose {
                message += " title=\(windowTitle ?? "-")"
              }
              logger.info(message)
            }
          }

          await dedupeState.updateAccepted(key: key, hash: hash, ocrText: ocrText)
        } catch {
          logger.warn("本轮采集失败：\(String(describing: error))")
        }

        if config.once {
          logger.info("已完成一次采集（--once），退出。")
          break
        }

        await sleepSeconds(config.intervalSeconds)
      }

      logger.info("收到退出信号，collector 结束。")
    } catch {
      let message = String(describing: error)
      fputs("[collector] 启动失败：\(message)\n", stderr)
      exit(1)
    }
  }
}

// MARK: - 参数解析（不引入第三方依赖，先保持最小可用）

private func parseConfig(args: [String]) -> CollectorConfig {
  var intervalSeconds: Double = 5
  var dedupeThreshold: Int = 2
  var captureMode: CaptureMode = .window
  var ocrLevel: OCRLevel = .fast
  var ocrLanguages: [String] = ["zh-Hans", "en-US"]
  var ocrLogEnabled = false
  var thumbnailEnabled = true
  // 说明：该缩略图既用于 UI 预览，也会被未来的视觉/多模态处理复用。
  // 420px 对 LLM 来说往往偏糊；这里把默认值适度提高，但仍保持对磁盘/CPU 的克制。
  var thumbnailMaxWidth = 720
  var excludedApps: [String] = []
  var dryRun = false
  var once = false
  var verbose = false

  var i = 1
  while i < args.count {
    let arg = args[i]
    switch arg {
    case "--interval":
      if i + 1 < args.count, let v = Double(args[i + 1]), v > 0 {
        intervalSeconds = v
        i += 2
      } else {
        printUsageAndExit("参数 --interval 需要一个正数（秒）")
      }
    case "--dedupe-threshold":
      if i + 1 < args.count, let v = Int(args[i + 1]) {
        dedupeThreshold = v
        i += 2
      } else {
        printUsageAndExit("参数 --dedupe-threshold 需要一个整数")
      }
    case "--capture-mode":
      if i + 1 < args.count, let v = CaptureMode(rawValue: args[i + 1]) {
        captureMode = v
        i += 2
      } else {
        printUsageAndExit("参数 --capture-mode 只能是 window 或 screen")
      }
    case "--ocr-level":
      if i + 1 < args.count, let v = OCRLevel(rawValue: args[i + 1]) {
        ocrLevel = v
        i += 2
      } else {
        printUsageAndExit("参数 --ocr-level 只能是 fast 或 accurate")
      }
    case "--ocr-log":
      ocrLogEnabled = true
      i += 1
    case "--ocr-lang":
      if i + 1 < args.count {
        let raw = args[i + 1]
        ocrLanguages = raw
          .split(separator: ",")
          .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
          .filter { !$0.isEmpty }
        i += 2
      } else {
        printUsageAndExit("参数 --ocr-lang 需要一个用逗号分隔的语言列表，例如 zh-Hans,en-US")
      }
    case "--no-thumbnails":
      thumbnailEnabled = false
      i += 1
    case "--thumbnail-width":
      if i + 1 < args.count, let v = Int(args[i + 1]) {
        thumbnailMaxWidth = v
        i += 2
      } else {
        printUsageAndExit("参数 --thumbnail-width 需要一个整数（像素）")
      }
    case "--exclude-app":
      if i + 1 < args.count {
        let raw = args[i + 1].trimmingCharacters(in: .whitespacesAndNewlines)
        if !raw.isEmpty, !excludedApps.contains(raw) {
          excludedApps.append(raw)
        }
        i += 2
      } else {
        printUsageAndExit("参数 --exclude-app 需要一个应用 Bundle ID（例如 com.google.Chrome）")
      }
    case "--exclude-apps":
      if i + 1 < args.count {
        let raw = args[i + 1]
        for part in raw.split(separator: ",") {
          let name = part.trimmingCharacters(in: .whitespacesAndNewlines)
          if name.isEmpty { continue }
          if !excludedApps.contains(name) { excludedApps.append(name) }
        }
        i += 2
      } else {
        printUsageAndExit("参数 --exclude-apps 需要一个用逗号分隔的应用 Bundle ID 列表")
      }
    case "--dry-run":
      dryRun = true
      i += 1
    case "--once":
      once = true
      i += 1
    case "--verbose":
      verbose = true
      i += 1
    case "--help", "-h":
      printUsageAndExit(nil)
    default:
      printUsageAndExit("未知参数：\(arg)")
    }
  }

  return CollectorConfig(
    intervalSeconds: intervalSeconds,
    dedupeThreshold: dedupeThreshold,
    captureMode: captureMode,
    ocrLevel: ocrLevel,
    ocrLanguages: ocrLanguages,
    ocrLogEnabled: ocrLogEnabled,
    thumbnailEnabled: thumbnailEnabled,
    thumbnailMaxWidth: thumbnailMaxWidth,
    excludedApps: excludedApps,
    dryRun: dryRun,
    once: once,
    verbose: verbose
  )
}

private func normalizeBundleId(_ value: String) -> String {
  value
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased()
}

private func isExcludedAppBundleId(_ bundleId: String, excludedBundleIds: [String]) -> Bool {
  if excludedBundleIds.isEmpty { return false }
  let normalized = normalizeBundleId(bundleId)
  if normalized.isEmpty { return false }

  return excludedBundleIds.contains { item in
    normalizeBundleId(item) == normalized
  }
}

@MainActor
private func resolveRunningAppIdentity(pid: pid_t) -> (bundleId: String?, name: String?) {
  let app = NSRunningApplication(processIdentifier: pid)
  let bundleId = app?.bundleIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines)
  let name = app?.localizedName?.trimmingCharacters(in: .whitespacesAndNewlines)

  let normalizedBundleId = (bundleId?.isEmpty == false) ? bundleId : nil
  let normalizedName = (name?.isEmpty == false) ? name : normalizedBundleId
  return (bundleId: normalizedBundleId, name: normalizedName)
}

private func printUsageAndExit(_ error: String?) -> Never {
  if let error {
    fputs("[collector] 参数错误：\(error)\n\n", stderr)
  }

  print(
    """
    用法：
      recapsense-collector [options]

    选项：
      --interval <seconds>           截图间隔（默认 5）
      --dedupe-threshold <int>       dHash 汉明距离阈值（默认 2；越大越激进）
      --capture-mode <window|screen> 截图范围（默认 window；screen 兼容性最好但更嘈杂）
      --ocr-level <fast|accurate>    OCR 模式（默认 fast）
      --ocr-log                      输出 OCR 全文到日志（调试用途，体量较大，默认关闭）
      --ocr-lang <a,b,c>             OCR 语言（默认 zh-Hans,en-US）
      --no-thumbnails                不写入缩略图文件
      --thumbnail-width <px>         缩略图最大宽度（默认 720）
      --exclude-app <bundleId>       应用黑名单（Bundle ID；遇到该应用则跳过采集；可重复传入）
      --exclude-apps <a,b,c>         应用黑名单（Bundle ID；逗号分隔；等价于多次 --exclude-app）
      --dry-run                      不写入 Agent，仅打印 OCR 摘要
      --once                         只采集一次就退出
      --verbose                      输出更多调试日志

    环境变量：
      RECAPSENSE_AGENT_URL           Agent 地址（默认 http://127.0.0.1:4832）
      RECAPSENSE_DATA_DIR            数据目录（默认 ./.recapsense）
      RECAPSENSE_API_TOKEN           API token（可选；不提供则从 dataDir/secret/token 读取）
    """
  )
  exit(2)
}

private func sleepSeconds(_ seconds: Double) async {
  let ns = UInt64(max(0, seconds) * 1_000_000_000)
  try? await Task.sleep(nanoseconds: ns)
}

private func formatLocalTimestamp(_ date: Date) -> String {
  let formatter = DateFormatter()
  formatter.locale = Locale(identifier: "zh_CN")
  formatter.timeZone = TimeZone.current
  formatter.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
  return formatter.string(from: date)
}

private func formatLocalDate(_ date: Date) -> String {
  let calendar = Calendar.current
  let year = calendar.component(.year, from: date)
  let month = calendar.component(.month, from: date)
  let day = calendar.component(.day, from: date)
  return String(format: "%04d-%02d-%02d", year, month, day)
}
