import Dispatch
import Foundation

actor StopController {
  private var stopRequested = false
  private var installed = false
  private var sigintSource: DispatchSourceSignal?
  private var sigtermSource: DispatchSourceSignal?

  func installSignalHandlers(log: @escaping (String) -> Void) {
    if installed { return }
    installed = true

    // 通过 GCD 处理信号，避免在 signal handler 里做任何非安全操作。
    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)

    let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
    sigint.setEventHandler { [weak self] in
      Task { await self?.requestStop(reason: "SIGINT") }
      log("收到 SIGINT（Ctrl+C），准备退出…")
    }
    sigint.resume()

    let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    sigterm.setEventHandler { [weak self] in
      Task { await self?.requestStop(reason: "SIGTERM") }
      log("收到 SIGTERM，准备退出…")
    }
    sigterm.resume()

    sigintSource = sigint
    sigtermSource = sigterm
  }

  func requestStop(reason: String) {
    stopRequested = true
  }

  func shouldStop() -> Bool {
    stopRequested
  }
}

