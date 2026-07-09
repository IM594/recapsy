import Foundation

/// Blocking-read stdin line reader on a dedicated thread. A blocking `read(2)`
/// on fd 0 gives unambiguous EOF semantics: `read` returns 0 exactly when the
/// write end (Electron's pipe) closes — which is also what happens if the
/// parent process is SIGKILL'd. That EOF is the orphan-protection trigger
/// required by ADR 0009: the capture process must exit itself when the parent
/// dies rather than linger as a zombie.
final class StdinReader {
    private let onLine: (String) -> Void
    private let onEOF: () -> Void
    private var buffer = Data()

    init(onLine: @escaping (String) -> Void, onEOF: @escaping () -> Void) {
        self.onLine = onLine
        self.onEOF = onEOF
    }

    func start() {
        let thread = Thread { [weak self] in
            self?.loop()
        }
        thread.name = "one.recapsy.capture.stdin"
        thread.start()
    }

    private func loop() {
        var chunk = [UInt8](repeating: 0, count: 8192)
        while true {
            let count = read(0, &chunk, chunk.count)
            if count < 0 {
                if errno == EINTR {
                    continue
                }
                break
            }
            if count == 0 {
                onEOF()
                return
            }
            buffer.append(contentsOf: chunk[0..<count])
            drainLines()
        }
        onEOF()
    }

    private func drainLines() {
        while let newlineIndex = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer.subdata(in: buffer.startIndex..<newlineIndex)
            buffer.removeSubrange(buffer.startIndex...newlineIndex)
            guard let line = String(data: lineData, encoding: .utf8) else {
                continue
            }
            if line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                continue
            }
            onLine(line)
        }
    }
}
