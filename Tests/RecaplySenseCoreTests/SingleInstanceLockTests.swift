import Foundation
import Testing
@testable import RecaplySenseCore

struct SingleInstanceLockTests {
    @Test("同一锁文件只允许一个实例持有")
    func shouldAllowOnlyOneOwner() throws {
        let lockPath = FileManager.default.temporaryDirectory
            .appendingPathComponent("recaply-sense-lock-\(UUID().uuidString).lock")

        let lockA = try SingleInstanceLock(lockFileURL: lockPath)
        let lockB = try SingleInstanceLock(lockFileURL: lockPath)

        #expect(try lockA.acquire() == true)
        #expect(try lockB.acquire() == false)

        lockA.release()

        #expect(try lockB.acquire() == true)
        lockB.release()
    }
}
