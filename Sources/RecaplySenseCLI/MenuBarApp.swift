import Foundation
import RecaplySenseCore

#if os(macOS)
import AppKit
import AVFoundation
import ApplicationServices

enum MenuBarAppMain {
    @MainActor
    private static var appDelegateRef: MenuBarAppDelegate?

    @MainActor
    private static var runtimeLock: SingleInstanceLock?

    static func run() -> Never {
        MainActor.assumeIsolated {
            do {
                let lockResult = try acquireRuntimeLock()
                switch lockResult {
                case .acquired(let lock):
                    runtimeLock = lock
                case .alreadyRunning:
                    fputs("[RecaplySenseCLI] another instance is already running.\n", stderr)
                    exit(0)
                case .failed(let message):
                    throw RecaplySenseError.invalidState(message: message)
                }
            } catch {
                fputs("[RecaplySenseCLI] failed to acquire single instance lock: \(error)\n", stderr)
                exit(1)
            }

            let app = NSApplication.shared
            app.setActivationPolicy(.accessory)

            let delegate = MenuBarAppDelegate()
            appDelegateRef = delegate
            app.delegate = delegate
            app.run()
        }

        fatalError("NSApplication exited unexpectedly")
    }

    @MainActor
    private static func appSupportDirectory() throws -> URL {
        let fm = FileManager.default
        guard let appSupport = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw RecaplySenseError.invalidState(message: "Cannot locate Application Support directory")
        }
        let dir = appSupport.appendingPathComponent("RecaplySense", isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    @MainActor
    private static func candidateLockDirectories() -> [URL] {
        var candidates: [URL] = []

        // Put temp directory first to avoid startup failure in restricted environments.
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("RecaplySense", isDirectory: true)
        candidates.append(tempDir)

        if let appSupport = try? appSupportDirectory() {
            candidates.append(appSupport)
        }
        return candidates
    }

    @MainActor
    private static func acquireRuntimeLock() throws -> LockAcquireResult {
        var errors: [String] = []

        for directory in candidateLockDirectories() {
            let lockURL = directory.appendingPathComponent("app.lock")
            do {
                let lock = try SingleInstanceLock(lockFileURL: lockURL)
                let acquired = try lock.acquire()
                if acquired {
                    return .acquired(lock)
                }
                return .alreadyRunning
            } catch {
                errors.append("\(lockURL.path): \(error.localizedDescription)")
            }
        }

        if errors.isEmpty {
            return .failed("No lock path candidates available")
        }

        return .failed(errors.joined(separator: " | "))
    }
}

private enum LockAcquireResult {
    case acquired(SingleInstanceLock)
    case alreadyRunning
    case failed(String)
}

@MainActor
private final class MenuBarAppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var lifecycleController: CaptureLifecycleController?
    private var store: MemoryStore?

    private var lastErrorMessage: String?
    private var dataDirectoryURL: URL?
    private var refreshTimer: Timer?
    private let compileTimeText = MenuBarAppDelegate.resolveCompileTimeText()
    private var mainWindow: NSWindow?
    private var statusValueLabel: NSTextField?
    private var permissionValueLabel: NSTextField?
    private var statsValueLabel: NSTextField?
    private var latestCaptureValueLabel: NSTextField?
    private var latestOCRValueLabel: NSTextField?
    private var latestChunkValueLabel: NSTextField?
    private var dataDirectoryValueLabel: NSTextField?
    private var errorValueLabel: NSTextField?
    private var hintValueLabel: NSTextField?
    private var startButton: NSButton?
    private var pauseButton: NSButton?
    private var resumeButton: NSButton?
    private var stopButton: NSButton?
    private var openDataButton: NSButton?

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupStatusItem()
        setupMainWindow()

        do {
            try setupRuntime()
        } catch {
            lastErrorMessage = error.localizedDescription
        }

        startRefreshTimer()
        refreshUI()
        showMainWindow()
    }

    func applicationWillTerminate(_ notification: Notification) {
        refreshTimer?.invalidate()
        refreshTimer = nil
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            showMainWindow()
        }
        return true
    }

    private func setupRuntime() throws {
        let dataDirectory = try ensureDataDirectory()
        dataDirectoryURL = dataDirectory

        let dbURL = dataDirectory.appendingPathComponent("memory.sqlite")
        let mediaDirectory = dataDirectory.appendingPathComponent("media", isDirectory: true)

        let memoryStore = try MemoryStore(databaseURL: dbURL)
        try memoryStore.bootstrapSchema()
        store = memoryStore

        let pipeline = OfflinePipeline(
            store: memoryStore,
            ocrProvider: VisionOCRProvider(),
            windowSize: 120
        )
        let source = try CaptureSourceFactory.makeDefault(mediaDirectory: mediaDirectory)
        let service = CaptureService(
            frameSource: source,
            pipeline: pipeline,
            onError: { [weak self] error in
                Task { @MainActor [weak self] in
                    self?.lastErrorMessage = error.localizedDescription
                    self?.refreshUI()
                }
            }
        )

        lifecycleController = CaptureLifecycleController(
            captureService: service,
            captureInterval: 2.0
        )
    }

    private func startRefreshTimer() {
        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.refreshUI()
            }
        }
    }

    private func ensureDataDirectory() throws -> URL {
        let fm = FileManager.default
        guard let appSupport = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw RecaplySenseError.invalidState(message: "Cannot locate Application Support directory")
        }

        let dir = appSupport.appendingPathComponent("RecaplySense", isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func setupStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "RS:S"
        statusItem = item
    }

    private func setupMainWindow() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 640, height: 520),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "RecaplySense"
        window.minSize = NSSize(width: 540, height: 460)
        window.isReleasedWhenClosed = false
        window.center()

        let titleLabel = NSTextField(labelWithString: "RecaplySense 主窗口")
        titleLabel.font = .systemFont(ofSize: 24, weight: .bold)

        let compileTimeLabel = NSTextField(labelWithString: "编译时间: \(compileTimeText)")
        compileTimeLabel.font = .systemFont(ofSize: 12, weight: .regular)
        compileTimeLabel.textColor = .tertiaryLabelColor
        compileTimeLabel.alignment = .left
        compileTimeLabel.lineBreakMode = .byTruncatingMiddle
        compileTimeLabel.toolTip = compileTimeText

        let subtitleLabel = NSTextField(labelWithString: "菜单栏只保留关键动作，详细状态统一放在这里。")
        subtitleLabel.font = .systemFont(ofSize: 14, weight: .regular)
        subtitleLabel.textColor = .secondaryLabelColor

        let headerStack = NSStackView(views: [titleLabel, subtitleLabel, compileTimeLabel])
        headerStack.orientation = .vertical
        headerStack.alignment = .leading
        headerStack.spacing = 6

        let infoStack = NSStackView()
        infoStack.orientation = .vertical
        infoStack.spacing = 14
        infoStack.alignment = .leading
        infoStack.translatesAutoresizingMaskIntoConstraints = false

        let statusRow = makeInfoRow(title: "状态")
        statusValueLabel = statusRow.valueLabel
        infoStack.addArrangedSubview(statusRow.rowView)

        let permissionRow = makeInfoRow(title: "权限")
        permissionValueLabel = permissionRow.valueLabel
        infoStack.addArrangedSubview(permissionRow.rowView)

        let statsRow = makeInfoRow(title: "数据统计")
        statsValueLabel = statsRow.valueLabel
        infoStack.addArrangedSubview(statsRow.rowView)

        let captureRow = makeInfoRow(title: "最近采集")
        latestCaptureValueLabel = captureRow.valueLabel
        infoStack.addArrangedSubview(captureRow.rowView)

        let ocrRow = makeInfoRow(title: "最近 OCR")
        latestOCRValueLabel = ocrRow.valueLabel
        infoStack.addArrangedSubview(ocrRow.rowView)

        let chunkRow = makeInfoRow(title: "最近文本")
        latestChunkValueLabel = chunkRow.valueLabel
        infoStack.addArrangedSubview(chunkRow.rowView)

        let dirRow = makeInfoRow(title: "数据目录")
        dataDirectoryValueLabel = dirRow.valueLabel
        infoStack.addArrangedSubview(dirRow.rowView)

        let errorRow = makeInfoRow(title: "最近错误")
        errorValueLabel = errorRow.valueLabel
        infoStack.addArrangedSubview(errorRow.rowView)

        let hintRow = makeInfoRow(title: "提示")
        hintValueLabel = hintRow.valueLabel
        infoStack.addArrangedSubview(hintRow.rowView)

        let infoCard = NSBox()
        infoCard.boxType = .custom
        infoCard.borderWidth = 1
        infoCard.borderColor = NSColor.separatorColor.withAlphaComponent(0.3)
        infoCard.cornerRadius = 12
        infoCard.fillColor = NSColor.controlBackgroundColor.withAlphaComponent(0.5)
        infoCard.titlePosition = .noTitle
        infoCard.contentViewMargins = NSSize(width: 20, height: 20)
        infoCard.translatesAutoresizingMaskIntoConstraints = false
        infoCard.heightAnchor.constraint(greaterThanOrEqualToConstant: 320).isActive = true

        let cardContent = NSView()
        cardContent.addSubview(infoStack)
        NSLayoutConstraint.activate([
            infoStack.leadingAnchor.constraint(equalTo: cardContent.leadingAnchor),
            infoStack.trailingAnchor.constraint(equalTo: cardContent.trailingAnchor),
            infoStack.topAnchor.constraint(equalTo: cardContent.topAnchor),
            infoStack.bottomAnchor.constraint(equalTo: cardContent.bottomAnchor),
        ])
        infoCard.contentView = cardContent

        let startButton = makeButton(title: "开始采集", action: #selector(startCapture))
        let pauseButton = makeButton(title: "暂停采集", action: #selector(pauseCapture))
        let resumeButton = makeButton(title: "继续采集", action: #selector(resumeCapture))
        let stopButton = makeButton(title: "停止采集", action: #selector(stopCapture))
        let openDataButton = makeButton(title: "打开数据目录", action: #selector(openDataDirectory))
        let refreshButton = makeButton(title: "立即刷新", action: #selector(refreshNow))

        let captureActionRow = NSStackView(views: [startButton, pauseButton, resumeButton, stopButton])
        captureActionRow.orientation = .horizontal
        captureActionRow.spacing = 8
        captureActionRow.distribution = .fillEqually

        let utilityActionRow = NSStackView(views: [openDataButton, refreshButton])
        utilityActionRow.orientation = .horizontal
        utilityActionRow.spacing = 8
        utilityActionRow.distribution = .fillEqually

        let contentStack = NSStackView(views: [headerStack, infoCard, captureActionRow, utilityActionRow])
        contentStack.orientation = .vertical
        contentStack.spacing = 20
        contentStack.alignment = .leading
        contentStack.translatesAutoresizingMaskIntoConstraints = false

        headerStack.widthAnchor.constraint(equalTo: contentStack.widthAnchor).isActive = true
        infoCard.widthAnchor.constraint(equalTo: contentStack.widthAnchor).isActive = true
        captureActionRow.widthAnchor.constraint(equalTo: contentStack.widthAnchor).isActive = true
        utilityActionRow.widthAnchor.constraint(equalTo: contentStack.widthAnchor).isActive = true

        let contentView = NSView()
        contentView.addSubview(contentStack)
        NSLayoutConstraint.activate([
            contentStack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 24),
            contentStack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -24),
            contentStack.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 24),
            contentStack.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -24),
        ])

        window.contentView = contentView
        mainWindow = window
        self.startButton = startButton
        self.pauseButton = pauseButton
        self.resumeButton = resumeButton
        self.stopButton = stopButton
        self.openDataButton = openDataButton
    }

    private func makeButton(title: String, action: Selector) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.bezelStyle = .rounded
        button.controlSize = .large
        button.font = .systemFont(ofSize: NSFont.systemFontSize(for: .large))
        button.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return button
    }

    private static func resolveCompileTimeText() -> String {
        guard let executablePath = CommandLine.arguments.first else {
            return "未知"
        }

        let executableURL = URL(fileURLWithPath: executablePath)
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: executableURL.path),
              let modifiedAt = attrs[.modificationDate] as? Date else {
            return "未知"
        }

        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.timeZone = TimeZone(identifier: "Asia/Shanghai")
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return formatter.string(from: modifiedAt)
    }

    private func makeInfoRow(title: String) -> (rowView: NSView, valueLabel: NSTextField) {
        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = .systemFont(ofSize: 13, weight: .medium)
        titleLabel.textColor = .secondaryLabelColor
        titleLabel.alignment = .left
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.widthAnchor.constraint(equalToConstant: 76).isActive = true
        titleLabel.setContentHuggingPriority(.required, for: .horizontal)

        let valueLabel = NSTextField(labelWithString: "-")
        valueLabel.font = .systemFont(ofSize: 13, weight: .regular)
        valueLabel.textColor = .labelColor
        valueLabel.lineBreakMode = .byWordWrapping
        valueLabel.maximumNumberOfLines = 2
        valueLabel.allowsDefaultTighteningForTruncation = true
        valueLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let row = NSStackView(views: [titleLabel, valueLabel])
        row.orientation = .horizontal
        row.alignment = .firstBaseline
        row.spacing = 12
        row.distribution = .fill
        return (row, valueLabel)
    }

    private func refreshUI() {
        refreshMenu()
        refreshMainWindow()
    }

    private func refreshMenu() {
        guard let statusItem else {
            return
        }

        let menu = NSMenu()
        menu.autoenablesItems = false

        let openMainItem = NSMenuItem(title: "打开 RecaplySense", action: #selector(showMainWindow), keyEquivalent: "")
        openMainItem.target = self
        menu.addItem(openMainItem)

        menu.addItem(.separator())

        switch lifecycleController?.state {
        case .running:
            let pauseItem = NSMenuItem(title: "暂停采集", action: #selector(pauseCapture), keyEquivalent: "")
            pauseItem.target = self
            menu.addItem(pauseItem)

            let stopItem = NSMenuItem(title: "停止采集", action: #selector(stopCapture), keyEquivalent: "")
            stopItem.target = self
            menu.addItem(stopItem)
        case .paused:
            let resumeItem = NSMenuItem(title: "继续采集", action: #selector(resumeCapture), keyEquivalent: "")
            resumeItem.target = self
            menu.addItem(resumeItem)

            let stopItem = NSMenuItem(title: "停止采集", action: #selector(stopCapture), keyEquivalent: "")
            stopItem.target = self
            menu.addItem(stopItem)
        case .stopped, .none:
            let startItem = NSMenuItem(title: "开始采集", action: #selector(startCapture), keyEquivalent: "")
            startItem.target = self
            menu.addItem(startItem)
        }

        if dataDirectoryURL != nil {
            let openDataItem = NSMenuItem(title: "打开数据目录", action: #selector(openDataDirectory), keyEquivalent: "")
            openDataItem.target = self
            menu.addItem(openDataItem)
        }

        menu.addItem(.separator())

        let quitItem = NSMenuItem(title: "退出 RecaplySense", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu
        updateStatusTitle()
    }

    private func refreshMainWindow() {
        updateValueLabel(statusValueLabel, text: lifecycleText())
        updateValueLabel(permissionValueLabel, text: permissionText())
        updateValueLabel(statsValueLabel, text: dataStatsText())
        updateValueLabel(latestCaptureValueLabel, text: latestCaptureText())
        updateValueLabel(latestOCRValueLabel, text: latestFrameOCRPreviewText())
        updateValueLabel(latestChunkValueLabel, text: latestChunkPreviewText())
        updateValueLabel(dataDirectoryValueLabel, text: dataDirectoryURL?.path ?? "未初始化")
        updateValueLabel(errorValueLabel, text: lastErrorMessage ?? "无")
        updateValueLabel(hintValueLabel, text: "当前阶段仅 screen 权限会阻塞采集。")

        startButton?.isEnabled = lifecycleController?.state == .stopped
        pauseButton?.isEnabled = lifecycleController?.state == .running
        resumeButton?.isEnabled = lifecycleController?.state == .paused
        stopButton?.isEnabled = lifecycleController?.state != .stopped
        openDataButton?.isEnabled = dataDirectoryURL != nil
    }

    private func updateValueLabel(_ label: NSTextField?, text: String) {
        label?.stringValue = text
        label?.toolTip = text
    }

    private func updateStatusTitle() {
        guard let button = statusItem?.button else {
            return
        }

        switch lifecycleController?.state {
        case .running:
            button.title = "RS:R"
        case .paused:
            button.title = "RS:P"
        case .stopped, .none:
            button.title = "RS:S"
        }
    }

    private func lifecycleText() -> String {
        switch lifecycleController?.state {
        case .running:
            return "运行中"
        case .paused:
            return "已暂停"
        case .stopped, .none:
            return "未启动"
        }
    }

    private func permissionText() -> String {
        let diagnostics = PermissionDiagnostics { permission in
            switch permission {
            case .screenRecording:
                return CGPreflightScreenCaptureAccess() ? .granted : .denied
            case .microphone:
                switch AVCaptureDevice.authorizationStatus(for: .audio) {
                case .authorized:
                    return .granted
                case .notDetermined:
                    return .notDetermined
                case .denied, .restricted:
                    return .denied
                @unknown default:
                    return .denied
                }
            case .accessibility:
                return AXIsProcessTrusted() ? .granted : .denied
            }
        }

        let snapshot = diagnostics.snapshot()
        let screen = statusText(snapshot.statusByPermission[.screenRecording])
        let mic = statusText(snapshot.statusByPermission[.microphone])
        let ax = statusText(snapshot.statusByPermission[.accessibility])

        return "screen=\(screen)（必需） mic=\(mic)（可选） accessibility=\(ax)（可选）"
    }

    private func dataStatsText() -> String {
        guard let store else {
            return "store 未就绪"
        }

        do {
            let frames = try store.countFrames()
            let chunks = try store.countChunks()
            return "frames=\(frames) chunks=\(chunks)"
        } catch {
            return "读取失败: \(error.localizedDescription)"
        }
    }

    private func latestCaptureText() -> String {
        guard let store else {
            return "-"
        }

        do {
            guard let latest = try store.latestFrameCapturedAt() else {
                return "暂无"
            }
            let formatter = ISO8601DateFormatter()
            formatter.timeZone = TimeZone(identifier: "Asia/Shanghai")
            formatter.formatOptions = [.withInternetDateTime]
            return formatter.string(from: latest)
        } catch {
            return "读取失败: \(error.localizedDescription)"
        }
    }

    private func latestChunkPreviewText() -> String {
        guard let store else {
            return "-"
        }

        do {
            guard let preview = try store.latestChunkPreview(maxLength: 50), !preview.isEmpty else {
                return "暂无"
            }
            return preview
        } catch {
            return "读取失败: \(error.localizedDescription)"
        }
    }

    private func latestFrameOCRPreviewText() -> String {
        guard let store else {
            return "-"
        }

        do {
            guard let preview = try store.latestFrameOCRPreview(maxLength: 50), !preview.isEmpty else {
                return "暂无"
            }
            return preview
        } catch {
            return "读取失败: \(error.localizedDescription)"
        }
    }

    private func statusText(_ status: PermissionStatus?) -> String {
        switch status {
        case .granted:
            return "已授权"
        case .denied:
            return "未授权"
        case .notDetermined:
            return "未决定"
        case .none:
            return "未知"
        }
    }

    @objc
    private func startCapture() {
        guard CGPreflightScreenCaptureAccess() else {
            _ = CGRequestScreenCaptureAccess()
            lastErrorMessage = "缺少 screen 权限，已触发系统授权弹窗；授权后请重启应用。"
            refreshUI()
            return
        }

        lifecycleController?.start()
        refreshUI()
    }

    @objc
    private func pauseCapture() {
        lifecycleController?.pause()
        refreshUI()
    }

    @objc
    private func resumeCapture() {
        lifecycleController?.resume()
        refreshUI()
    }

    @objc
    private func stopCapture() {
        do {
            try lifecycleController?.stop()
        } catch {
            lastErrorMessage = error.localizedDescription
        }
        refreshUI()
    }

    @objc
    private func quitApp() {
        do {
            try lifecycleController?.stop()
        } catch {
            lastErrorMessage = error.localizedDescription
        }
        NSApplication.shared.terminate(nil)
    }

    @objc
    private func showMainWindow() {
        guard let mainWindow else {
            return
        }
        NSApplication.shared.activate(ignoringOtherApps: true)
        mainWindow.makeKeyAndOrderFront(nil)
    }

    @objc
    private func refreshNow() {
        refreshUI()
    }

    @objc
    private func openDataDirectory() {
        guard let dataDirectoryURL else {
            return
        }

        NSWorkspace.shared.activateFileViewerSelecting([dataDirectoryURL])
    }
}

#else

enum MenuBarAppMain {
    static func run() -> Never {
        fputs("MenuBar mode is only available on macOS.\n", stderr)
        exit(1)
    }
}

#endif
