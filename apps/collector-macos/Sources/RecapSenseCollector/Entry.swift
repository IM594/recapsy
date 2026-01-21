import CoreGraphics
import Foundation

struct CollectorConfig {
  let intervalSeconds: Double
  let dedupeThreshold: Int
  let ocrLevel: OCRLevel
  let ocrLanguages: [String]
  let thumbnailEnabled: Bool
  let thumbnailMaxWidth: Int
  let dryRun: Bool
  let once: Bool
  let verbose: Bool
}

struct Logger {
  let verbose: Bool

  func info(_ message: String) {
    print("[collector] \(message)")
  }

  func debug(_ message: String) {
    guard verbose else { return }
    print("[collector][debug] \(message)")
  }

  func warn(_ message: String) {
    print("[collector][warn] \(message)")
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

@main
struct RecapSenseCollectorMain {
  static func main() async {
    let config = parseConfig(args: CommandLine.arguments)
    let logger = Logger(verbose: config.verbose)
    let notices = OneTimeNotice()

    do {
      let dataDir = resolveDataDir()
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
      if config.dryRun {
        logger.warn("当前为 dry-run：不会写入 Agent（仅本地打印摘要）")
      }

      let stop = StopController()
      await stop.installSignalHandlers(log: logger.info)

      let dedupeState = DedupeState()
      let paths = CollectorPaths(dataDir: dataDir)

      var tickIndex = 0
      while !(await stop.shouldStop()) {
        tickIndex += 1

        do {
          let context = await MainActor.run {
            readFrontmostAppContext(log: { message in
              notices.once(key: "ax-permission") { logger.warn(message) }
            })
          }

          let appName = context.appName
          let windowTitle = context.windowTitle
          let key = "\(appName ?? "")\n\(windowTitle ?? "")"

          guard let screenshot = CGDisplayCreateImage(CGMainDisplayID()) else {
            notices.once(key: "screen-recording") {
              logger.warn("无法截屏：请在 系统设置 → 隐私与安全性 → 屏幕录制 中给 recapsense-collector（或你运行它的终端）授权。")
            }
            await sleepSeconds(config.intervalSeconds)
            continue
          }

          let hash = try computeDHash64(from: screenshot)
          if await dedupeState.shouldSkip(key: key, hash: hash, threshold: config.dedupeThreshold) {
            logger.debug("去重命中（跳过 OCR）：app=\(appName ?? "Unknown") hash=\(hash.stringValue)")
            await sleepSeconds(config.intervalSeconds)
            continue
          }

          let ocrText = try recognizeText(from: screenshot, level: config.ocrLevel, languages: config.ocrLanguages)
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

          let tsMs = Int64(Date().timeIntervalSince1970 * 1000)
          var thumbnailPath: String? = nil
          if config.thumbnailEnabled {
            let localDate = formatLocalDate(Date())
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
            windowTitle: windowTitle,
            ocrText: ocrText,
            phash: hash.stringValue,
            screenshotPath: nil,
            thumbnailPath: thumbnailPath
          )

          if config.dryRun {
            let preview = String(ocrText.prefix(220))
            logger.info("dry-run frame：app=\(appName ?? "Unknown") title=\(windowTitle ?? "-") text=\(preview)")
          } else {
            let id = try await client.ingestFrame(payload)
            logger.info("写入 frame 成功：id=\(id.map(String.init) ?? "?") app=\(appName ?? "Unknown")")
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
  var ocrLevel: OCRLevel = .fast
  var ocrLanguages: [String] = ["zh-Hans", "en-US"]
  var thumbnailEnabled = true
  var thumbnailMaxWidth = 420
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
    case "--ocr-level":
      if i + 1 < args.count, let v = OCRLevel(rawValue: args[i + 1]) {
        ocrLevel = v
        i += 2
      } else {
        printUsageAndExit("参数 --ocr-level 只能是 fast 或 accurate")
      }
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
    ocrLevel: ocrLevel,
    ocrLanguages: ocrLanguages,
    thumbnailEnabled: thumbnailEnabled,
    thumbnailMaxWidth: thumbnailMaxWidth,
    dryRun: dryRun,
    once: once,
    verbose: verbose
  )
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
      --ocr-level <fast|accurate>    OCR 模式（默认 fast）
      --ocr-lang <a,b,c>             OCR 语言（默认 zh-Hans,en-US）
      --no-thumbnails                不写入缩略图文件
      --thumbnail-width <px>         缩略图最大宽度（默认 420）
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

private func formatLocalDate(_ date: Date) -> String {
  let calendar = Calendar.current
  let year = calendar.component(.year, from: date)
  let month = calendar.component(.month, from: date)
  let day = calendar.component(.day, from: date)
  return String(format: "%04d-%02d-%02d", year, month, day)
}
