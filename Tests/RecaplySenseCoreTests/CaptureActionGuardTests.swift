import Testing
@testable import RecaplySenseCore

struct CaptureActionGuardTests {
    @Test("CaptureActionGuard 无 screen 权限时 start 不应执行且应请求授权")
    func shouldRejectStartWithoutScreenPermission() {
        let guarder = CaptureActionGuard()

        let resolution = guarder.resolve(
            action: .start,
            lifecycleState: .stopped,
            hasScreenPermission: false
        )

        #expect(resolution.operation == nil)
        #expect(resolution.shouldRequestScreenPermission == true)
        #expect(resolution.errorMessage == "缺少 screen 权限，已触发系统授权弹窗；授权后请重启应用。")
    }

    @Test("CaptureActionGuard stopped 且有权限时应允许 start")
    func shouldAllowStartWhenStoppedWithPermission() {
        let guarder = CaptureActionGuard()

        let resolution = guarder.resolve(
            action: .start,
            lifecycleState: .stopped,
            hasScreenPermission: true
        )

        #expect(resolution.operation == .start)
        #expect(resolution.shouldRequestScreenPermission == false)
        #expect(resolution.errorMessage == nil)
    }

    @Test("CaptureActionGuard 仅 running 状态允许 pause")
    func shouldAllowPauseOnlyWhenRunning() {
        let guarder = CaptureActionGuard()

        let running = guarder.resolve(
            action: .pause,
            lifecycleState: .running,
            hasScreenPermission: true
        )
        #expect(running.operation == .pause)

        let paused = guarder.resolve(
            action: .pause,
            lifecycleState: .paused,
            hasScreenPermission: true
        )
        #expect(paused.operation == nil)
    }

    @Test("CaptureActionGuard 仅 paused 状态允许 resume，stop 在非 stopped 可执行")
    func shouldResolveResumeAndStopByState() {
        let guarder = CaptureActionGuard()

        let resumePaused = guarder.resolve(
            action: .resume,
            lifecycleState: .paused,
            hasScreenPermission: true
        )
        #expect(resumePaused.operation == .resume)

        let resumeRunning = guarder.resolve(
            action: .resume,
            lifecycleState: .running,
            hasScreenPermission: true
        )
        #expect(resumeRunning.operation == nil)

        let stopRunning = guarder.resolve(
            action: .stop,
            lifecycleState: .running,
            hasScreenPermission: true
        )
        #expect(stopRunning.operation == .stop)

        let stopStopped = guarder.resolve(
            action: .stop,
            lifecycleState: .stopped,
            hasScreenPermission: true
        )
        #expect(stopStopped.operation == nil)
    }
}
