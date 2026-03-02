import Foundation
import Testing
@testable import RecaplySenseCore

struct ScreenCaptureKitLiveImageProviderTests {
    @Test("syncAwaitValue 应返回 async 操作结果")
    func shouldReturnValueFromAsyncOperation() throws {
        let value: Int = try syncAwaitValue {
            42
        }
        #expect(value == 42)
    }

    @Test("syncAwaitValue 应透传 async 抛出的错误")
    func shouldRethrowErrorFromAsyncOperation() {
        struct AsyncFailure: Error {}

        #expect(throws: AsyncFailure.self) {
            _ = try syncAwaitValue {
                throw AsyncFailure()
            }
        }
    }

    @Test("ScreenCaptureKitLiveImageProvider 应返回图像或可读错误")
    func shouldCaptureImageOrThrowReadableError() {
        do {
            _ = try ScreenCaptureKitLiveImageProvider.captureImage()
        } catch {
            let description: String
            if let localizedError = error as? LocalizedError,
               let message = localizedError.errorDescription {
                description = message
            } else {
                description = String(describing: error)
            }
            #expect(!description.isEmpty)
        }
    }
}
