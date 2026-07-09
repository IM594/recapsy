import Foundation

// Entry point for the Recapsy macOS capture process (ADR 0009). Wires the
// stdin NDJSON reader to the capture state machine and parks the main thread on
// `dispatchMain()` so GCD timers and the capture worker keep running until an
// explicit `exit` (shutdown command or stdin EOF).

/// Asset root is injected via the environment, never hard-coded (cross-process
/// contract with Electron). Absent → captures fail-closed with
/// `asset_write_failed` rather than guessing a path.
let assetRoot: URL? = {
    guard let raw = ProcessInfo.processInfo.environment["RECAPSY_CAPTURE_ASSET_ROOT"],
          !raw.isEmpty
    else {
        return nil
    }
    return URL(fileURLWithPath: raw, isDirectory: true)
}()

let emitter = LineEmitter()
let engine = CaptureEngine(emitter: emitter, assetRoot: assetRoot)

let stdinReader = StdinReader(
    onLine: { line in
        engine.handleLine(line)
    },
    onEOF: {
        engine.handleStdinEOF()
    }
)

engine.start()
stdinReader.start()

dispatchMain()
