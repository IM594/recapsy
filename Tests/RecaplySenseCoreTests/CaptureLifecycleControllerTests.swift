import Foundation
import Testing
@testable import RecaplySenseCore

struct CaptureLifecycleControllerTests {
    @Test("start/pause/resume/stop 应驱动正确状态与服务调用")
    func shouldTransitionLifecycleState() throws {
        let service = StubCaptureServiceController()
        let controller = CaptureLifecycleController(
            captureService: service,
            captureInterval: 2.0
        )

        #expect(controller.state == .stopped)

        controller.start()
        #expect(controller.state == .running)
        #expect(service.startCallCount == 1)
        #expect(service.lastInterval == 2.0)

        controller.pause()
        #expect(controller.state == .paused)
        #expect(service.stopCallCount == 1)

        controller.resume()
        #expect(controller.state == .running)
        #expect(service.startCallCount == 2)

        try controller.stop()
        #expect(controller.state == .stopped)
        #expect(service.stopAndFlushCallCount == 1)
    }

    @Test("重复 start 在 running 状态下应幂等")
    func shouldIgnoreDuplicateStart() {
        let service = StubCaptureServiceController()
        let controller = CaptureLifecycleController(
            captureService: service,
            captureInterval: 2.0
        )

        controller.start()
        controller.start()

        #expect(service.startCallCount == 1)
        #expect(controller.state == .running)
    }
}

private final class StubCaptureServiceController: CaptureServiceControlling {
    private(set) var startCallCount = 0
    private(set) var stopCallCount = 0
    private(set) var stopAndFlushCallCount = 0
    private(set) var lastInterval: TimeInterval?

    func start(interval: TimeInterval) {
        startCallCount += 1
        lastInterval = interval
    }

    func stop() {
        stopCallCount += 1
    }

    func stopAndFlush() throws {
        stopAndFlushCallCount += 1
    }
}
