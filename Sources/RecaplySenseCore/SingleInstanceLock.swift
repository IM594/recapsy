import Foundation
import Darwin

public final class SingleInstanceLock {
    private let lockFileURL: URL
    private var fileDescriptor: Int32 = -1
    private var ownsLock = false

    public init(lockFileURL: URL) throws {
        self.lockFileURL = lockFileURL
        let directoryURL = lockFileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
    }

    deinit {
        release()
    }

    @discardableResult
    public func acquire() throws -> Bool {
        if ownsLock {
            return true
        }

        if fileDescriptor == -1 {
            fileDescriptor = open(lockFileURL.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
            if fileDescriptor == -1 {
                let openErrno = errno
                let openMessage = String(cString: strerror(openErrno))
                throw RecaplySenseError.invalidState(
                    message: "Cannot open lock file at \(lockFileURL.path), errno=\(openErrno) (\(openMessage))"
                )
            }
        }

        if flock(fileDescriptor, LOCK_EX | LOCK_NB) == 0 {
            ownsLock = true
            return true
        }

        let currentErrno = errno
        if currentErrno == EWOULDBLOCK {
            return false
        }

        throw RecaplySenseError.invalidState(message: "Cannot lock file, errno=\(currentErrno)")
    }

    public func release() {
        guard fileDescriptor != -1 else {
            return
        }

        if ownsLock {
            _ = flock(fileDescriptor, LOCK_UN)
            ownsLock = false
        }

        _ = close(fileDescriptor)
        fileDescriptor = -1
    }
}
