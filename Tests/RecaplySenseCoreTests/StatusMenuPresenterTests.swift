import Testing
@testable import RecaplySenseCore

struct StatusMenuPresenterTests {
    @Test("StatusMenuPresenter running 且有数据目录时应输出 pause/stop/openData 菜单")
    func shouldBuildRunningMenuEntries() {
        let presenter = StatusMenuPresenter()
        let entries = presenter.makeEntries(
            lifecycleState: .running,
            hasDataDirectory: true
        )

        #expect(
            entries == [
                .item(title: "打开 RecaplySense", action: .openMain, keyEquivalent: ""),
                .separator,
                .item(title: "暂停采集", action: .pause, keyEquivalent: ""),
                .item(title: "停止采集", action: .stop, keyEquivalent: ""),
                .item(title: "打开数据目录", action: .openDataDirectory, keyEquivalent: ""),
                .separator,
                .item(title: "退出 RecaplySense", action: .quit, keyEquivalent: "q"),
            ]
        )
    }

    @Test("StatusMenuPresenter paused 且无数据目录时应输出 resume/stop 且不含 openData")
    func shouldBuildPausedMenuEntriesWithoutDataDirectory() {
        let presenter = StatusMenuPresenter()
        let entries = presenter.makeEntries(
            lifecycleState: .paused,
            hasDataDirectory: false
        )

        #expect(
            entries == [
                .item(title: "打开 RecaplySense", action: .openMain, keyEquivalent: ""),
                .separator,
                .item(title: "继续采集", action: .resume, keyEquivalent: ""),
                .item(title: "停止采集", action: .stop, keyEquivalent: ""),
                .separator,
                .item(title: "退出 RecaplySense", action: .quit, keyEquivalent: "q"),
            ]
        )
    }

    @Test("StatusMenuPresenter stopped 时应输出 start 菜单")
    func shouldBuildStoppedMenuEntries() {
        let presenter = StatusMenuPresenter()
        let entries = presenter.makeEntries(
            lifecycleState: .stopped,
            hasDataDirectory: false
        )

        #expect(
            entries == [
                .item(title: "打开 RecaplySense", action: .openMain, keyEquivalent: ""),
                .separator,
                .item(title: "开始采集", action: .start, keyEquivalent: ""),
                .separator,
                .item(title: "退出 RecaplySense", action: .quit, keyEquivalent: "q"),
            ]
        )
    }
}
