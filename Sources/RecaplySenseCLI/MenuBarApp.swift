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

    private var lastErrorMessage: String?
    private var dataDirectoryURL: URL?

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupStatusItem()

        do {
            try setupRuntime()
        } catch {
            lastErrorMessage = error.localizedDescription
        }

        refreshMenu()
    }

    private func setupRuntime() throws {
        let dataDirectory = try ensureDataDirectory()
        dataDirectoryURL = dataDirectory

        let dbURL = dataDirectory.appendingPathComponent("memory.sqlite")
        let mediaDirectory = dataDirectory.appendingPathComponent("media", isDirectory: true)

        let store = try MemoryStore(databaseURL: dbURL)
        try store.bootstrapSchema()

        let pipeline = OfflinePipeline(
            store: store,
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
                    self?.refreshMenu()
                }
            }
        )

        lifecycleController = CaptureLifecycleController(
            captureService: service,
            captureInterval: 2.0
        )
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

    private func refreshMenu() {
        guard let statusItem else {
            return
        }

        let menu = NSMenu()

        let stateText = "状态: \(lifecycleText())"
        let stateItem = NSMenuItem(title: stateText, action: nil, keyEquivalent: "")
        stateItem.isEnabled = false
        menu.addItem(stateItem)

        let permissionItem = NSMenuItem(title: permissionText(), action: nil, keyEquivalent: "")
        permissionItem.isEnabled = false
        menu.addItem(permissionItem)

        if let dataDirectoryURL {
            let dataItem = NSMenuItem(title: "数据目录: \(dataDirectoryURL.path)", action: nil, keyEquivalent: "")
            dataItem.isEnabled = false
            menu.addItem(dataItem)
        }

        if let lastErrorMessage {
            let errorItem = NSMenuItem(title: "最近错误: \(lastErrorMessage)", action: nil, keyEquivalent: "")
            errorItem.isEnabled = false
            menu.addItem(errorItem)
        }

        menu.addItem(.separator())

        let startItem = NSMenuItem(title: "Start", action: #selector(startCapture), keyEquivalent: "s")
        startItem.target = self
        startItem.isEnabled = lifecycleController?.state == .stopped
        menu.addItem(startItem)

        let pauseItem = NSMenuItem(title: "Pause", action: #selector(pauseCapture), keyEquivalent: "p")
        pauseItem.target = self
        pauseItem.isEnabled = lifecycleController?.state == .running
        menu.addItem(pauseItem)

        let resumeItem = NSMenuItem(title: "Resume", action: #selector(resumeCapture), keyEquivalent: "r")
        resumeItem.target = self
        resumeItem.isEnabled = lifecycleController?.state == .paused
        menu.addItem(resumeItem)

        let stopItem = NSMenuItem(title: "Stop", action: #selector(stopCapture), keyEquivalent: "t")
        stopItem.target = self
        stopItem.isEnabled = lifecycleController?.state != .stopped
        menu.addItem(stopItem)

        menu.addItem(.separator())

        let quitItem = NSMenuItem(title: "Quit", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu
        updateStatusTitle()
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
            return "running"
        case .paused:
            return "paused"
        case .stopped, .none:
            return "stopped"
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

        return "权限 screen=\(screen) mic=\(mic) accessibility=\(ax)"
    }

    private func statusText(_ status: PermissionStatus?) -> String {
        switch status {
        case .granted:
            return "granted"
        case .denied:
            return "denied"
        case .notDetermined:
            return "not_determined"
        case .none:
            return "unknown"
        }
    }

    @objc
    private func startCapture() {
        lifecycleController?.start()
        refreshMenu()
    }

    @objc
    private func pauseCapture() {
        lifecycleController?.pause()
        refreshMenu()
    }

    @objc
    private func resumeCapture() {
        lifecycleController?.resume()
        refreshMenu()
    }

    @objc
    private func stopCapture() {
        do {
            try lifecycleController?.stop()
        } catch {
            lastErrorMessage = error.localizedDescription
        }
        refreshMenu()
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
}

#else

enum MenuBarAppMain {
    static func run() -> Never {
        fputs("MenuBar mode is only available on macOS.\n", stderr)
        exit(1)
    }
}

#endif
