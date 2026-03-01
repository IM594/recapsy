import Foundation
import Testing
@testable import RecaplySenseCore

struct DashboardSnapshotServiceTests {
    @Test("DashboardSnapshotService 应生成完整主路径快照")
    func shouldBuildSnapshotForHappyPath() throws {
        let dbURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("recaply-sense-dashboard-\(UUID().uuidString).sqlite")
        let store = try MemoryStore(databaseURL: dbURL)
        try store.bootstrapSchema()

        let t0 = Date(timeIntervalSince1970: 1_700_000_000)
        let t1 = t0.addingTimeInterval(60)

        _ = try store.insertFrame(
            FrameInsert(
                capturedAt: t1,
                appName: "Xcode",
                windowTitle: "Editor",
                ocrText: "latest frame ocr text",
                contentHash: "dashboard-hash-1"
            )
        )
        _ = try store.insertChunk(
            ChunkInsert(
                startAt: t0,
                endAt: t1,
                text: "latest chunk snapshot text",
                appName: "Xcode",
                windowTitle: "Editor"
            )
        )

        let service = DashboardSnapshotService()
        let snapshot = service.makeSnapshot(
            lifecycleState: .running,
            store: store,
            dataDirectoryURL: URL(fileURLWithPath: "/tmp/recaply-sense"),
            lastErrorMessage: nil,
            permissionChecker: { permission in
                switch permission {
                case .screenRecording: return .granted
                case .microphone: return .denied
                case .accessibility: return .notDetermined
                }
            }
        )

        #expect(snapshot.statusText == "运行中")
        #expect(snapshot.permissionText.contains("screen=已授权"))
        #expect(snapshot.statsText == "frames=1 chunks=1")
        #expect(snapshot.latestFrameOCRText == "latest frame ocr text")
        #expect(snapshot.latestChunkText == "latest chunk snapshot text")
        #expect(snapshot.dataDirectoryText == "/tmp/recaply-sense")
        #expect(snapshot.errorText == "无")
    }

    @Test("DashboardSnapshotService 当存储异常时应返回字段级失败文案")
    func shouldReturnFailureTextsWhenStoreThrows() {
        let service = DashboardSnapshotService()
        let snapshot = service.makeSnapshot(
            lifecycleState: .paused,
            store: ThrowingDashboardStore(),
            dataDirectoryURL: nil,
            lastErrorMessage: "boom",
            permissionChecker: { _ in .granted }
        )

        #expect(snapshot.statusText == "已暂停")
        #expect(snapshot.statsText.contains("读取失败"))
        #expect(snapshot.latestCaptureText.contains("读取失败"))
        #expect(snapshot.latestFrameOCRText.contains("读取失败"))
        #expect(snapshot.latestChunkText.contains("读取失败"))
        #expect(snapshot.dataDirectoryText == "未初始化")
        #expect(snapshot.errorText == "boom")
    }

    @Test("DashboardSnapshotService 当存储未就绪时应返回占位文案")
    func shouldReturnPlaceholderWhenStoreUnavailable() {
        let service = DashboardSnapshotService()
        let snapshot = service.makeSnapshot(
            lifecycleState: .stopped,
            store: nil,
            dataDirectoryURL: nil,
            lastErrorMessage: nil,
            permissionChecker: { _ in .notDetermined }
        )

        #expect(snapshot.statusText == "未启动")
        #expect(snapshot.statsText == "store 未就绪")
        #expect(snapshot.latestCaptureText == "-")
        #expect(snapshot.latestFrameOCRText == "-")
        #expect(snapshot.latestChunkText == "-")
    }
}

private struct ThrowingDashboardStore: DashboardStoreReadable {
    func countFrames() throws -> Int {
        throw RecaplySenseError.sqlite(message: "count frames failed")
    }

    func countChunks() throws -> Int {
        throw RecaplySenseError.sqlite(message: "count chunks failed")
    }

    func latestFrameCapturedAt() throws -> Date? {
        throw RecaplySenseError.sqlite(message: "latest frame failed")
    }

    func latestChunkPreview(maxLength: Int) throws -> String? {
        _ = maxLength
        throw RecaplySenseError.sqlite(message: "latest chunk failed")
    }

    func latestFrameOCRPreview(maxLength: Int) throws -> String? {
        _ = maxLength
        throw RecaplySenseError.sqlite(message: "latest frame ocr failed")
    }
}
