import Foundation
import Testing
@testable import RecaplySenseCore

struct PermissionDiagnosticsTests {
    @Test("权限快照应包含屏幕与麦克风状态")
    func shouldBuildPermissionSnapshot() {
        let diagnostics = PermissionDiagnostics(
            checker: { permission in
                switch permission {
                case .screenRecording: return .granted
                case .microphone: return .denied
                case .accessibility: return .notDetermined
                }
            }
        )

        let snapshot = diagnostics.snapshot()

        #expect(snapshot.statusByPermission[.screenRecording] == .granted)
        #expect(snapshot.statusByPermission[.microphone] == .denied)
        #expect(snapshot.statusByPermission[.accessibility] == .notDetermined)
        #expect(snapshot.hasBlockingPermission == true)
    }
}
