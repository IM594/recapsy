import Foundation

public protocol DashboardStoreReadable {
    func countFrames() throws -> Int
    func countChunks() throws -> Int
    func latestFrameCapturedAt() throws -> Date?
    func latestChunkPreview(maxLength: Int) throws -> String?
    func latestFrameOCRPreview(maxLength: Int) throws -> String?
}

extension MemoryStore: DashboardStoreReadable {}

public struct DashboardSnapshot: Sendable {
    public let statusText: String
    public let permissionText: String
    public let statsText: String
    public let latestCaptureText: String
    public let latestFrameOCRText: String
    public let latestChunkText: String
    public let dataDirectoryText: String
    public let errorText: String
    public let hintText: String

    public init(
        statusText: String,
        permissionText: String,
        statsText: String,
        latestCaptureText: String,
        latestFrameOCRText: String,
        latestChunkText: String,
        dataDirectoryText: String,
        errorText: String,
        hintText: String
    ) {
        self.statusText = statusText
        self.permissionText = permissionText
        self.statsText = statsText
        self.latestCaptureText = latestCaptureText
        self.latestFrameOCRText = latestFrameOCRText
        self.latestChunkText = latestChunkText
        self.dataDirectoryText = dataDirectoryText
        self.errorText = errorText
        self.hintText = hintText
    }
}

public struct DashboardSnapshotService {
    public init() {}

    public func makeSnapshot(
        lifecycleState: CaptureLifecycleState?,
        store: (any DashboardStoreReadable)?,
        dataDirectoryURL: URL?,
        lastErrorMessage: String?,
        permissionChecker: @escaping PermissionDiagnostics.Checker
    ) -> DashboardSnapshot {
        DashboardSnapshot(
            statusText: lifecycleText(lifecycleState),
            permissionText: permissionText(permissionChecker: permissionChecker),
            statsText: dataStatsText(store: store),
            latestCaptureText: latestCaptureText(store: store),
            latestFrameOCRText: latestFrameOCRText(store: store),
            latestChunkText: latestChunkText(store: store),
            dataDirectoryText: dataDirectoryURL?.path ?? "未初始化",
            errorText: lastErrorMessage ?? "无",
            hintText: "当前阶段仅 screen 权限会阻塞采集。"
        )
    }

    private func lifecycleText(_ state: CaptureLifecycleState?) -> String {
        switch state {
        case .running:
            return "运行中"
        case .paused:
            return "已暂停"
        case .stopped, .none:
            return "未启动"
        }
    }

    private func permissionText(permissionChecker: @escaping PermissionDiagnostics.Checker) -> String {
        let diagnostics = PermissionDiagnostics(checker: permissionChecker)
        let snapshot = diagnostics.snapshot()

        let screen = statusText(snapshot.statusByPermission[.screenRecording])
        let mic = statusText(snapshot.statusByPermission[.microphone])
        let ax = statusText(snapshot.statusByPermission[.accessibility])

        return "screen=\(screen)（必需） mic=\(mic)（可选） accessibility=\(ax)（可选）"
    }

    private func dataStatsText(store: (any DashboardStoreReadable)?) -> String {
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

    private func latestCaptureText(store: (any DashboardStoreReadable)?) -> String {
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

    private func latestChunkText(store: (any DashboardStoreReadable)?) -> String {
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

    private func latestFrameOCRText(store: (any DashboardStoreReadable)?) -> String {
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
}
