import Foundation
import Testing
@testable import RecaplySenseCore

struct MainWindowPresenterTests {
    @Test("MainWindowPresenter 在 running 状态应产出运行态按钮与状态标题")
    func shouldBuildRunningViewModel() {
        let presenter = MainWindowPresenter()
        let snapshot = DashboardSnapshot(
            statusText: "运行中",
            permissionText: "screen=已授权（必需） mic=未授权（可选） accessibility=未决定（可选）",
            statsText: "frames=12 chunks=3",
            latestCaptureText: "2026-03-02T00:00:00Z",
            latestFrameOCRText: "hello world",
            latestChunkText: "chunk preview",
            dataDirectoryText: "/tmp/recaply",
            errorText: "无",
            hintText: "当前阶段仅 screen 权限会阻塞采集。"
        )

        let viewModel = presenter.makeViewModel(
            snapshot: snapshot,
            lifecycleState: .running,
            hasDataDirectory: true
        )

        #expect(viewModel.statusItemTitle == "RS:R")
        #expect(viewModel.startButtonEnabled == false)
        #expect(viewModel.pauseButtonEnabled == true)
        #expect(viewModel.resumeButtonEnabled == false)
        #expect(viewModel.stopButtonEnabled == true)
        #expect(viewModel.openDataButtonEnabled == true)
        #expect(viewModel.statsText == "frames=12 chunks=3")
    }

    @Test("MainWindowPresenter 当目录缺失时应禁用打开目录按钮")
    func shouldDisableOpenDataButtonWhenDirectoryMissing() {
        let presenter = MainWindowPresenter()
        let snapshot = DashboardSnapshot(
            statusText: "未启动",
            permissionText: "screen=未知（必需） mic=未知（可选） accessibility=未知（可选）",
            statsText: "store 未就绪",
            latestCaptureText: "-",
            latestFrameOCRText: "-",
            latestChunkText: "-",
            dataDirectoryText: "未初始化",
            errorText: "无",
            hintText: "当前阶段仅 screen 权限会阻塞采集。"
        )

        let viewModel = presenter.makeViewModel(
            snapshot: snapshot,
            lifecycleState: .stopped,
            hasDataDirectory: false
        )

        #expect(viewModel.statusItemTitle == "RS:S")
        #expect(viewModel.startButtonEnabled == true)
        #expect(viewModel.pauseButtonEnabled == false)
        #expect(viewModel.resumeButtonEnabled == false)
        #expect(viewModel.stopButtonEnabled == false)
        #expect(viewModel.openDataButtonEnabled == false)
    }

    @Test("MainWindowPresenter 应保留 error 字段且不污染统计字段")
    func shouldKeepErrorTextWithoutBreakingStats() {
        let presenter = MainWindowPresenter()
        let snapshot = DashboardSnapshot(
            statusText: "已暂停",
            permissionText: "screen=已授权（必需） mic=未授权（可选） accessibility=未授权（可选）",
            statsText: "frames=5 chunks=2",
            latestCaptureText: "2026-03-02T00:00:00Z",
            latestFrameOCRText: "ocr",
            latestChunkText: "chunk",
            dataDirectoryText: "/tmp/recaply",
            errorText: "数据库暂时不可用",
            hintText: "当前阶段仅 screen 权限会阻塞采集。"
        )

        let viewModel = presenter.makeViewModel(
            snapshot: snapshot,
            lifecycleState: .paused,
            hasDataDirectory: true
        )

        #expect(viewModel.statusItemTitle == "RS:P")
        #expect(viewModel.errorText == "数据库暂时不可用")
        #expect(viewModel.statsText == "frames=5 chunks=2")
    }
}
