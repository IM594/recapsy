import Foundation

struct AgentProcessDiagnostics: Equatable {
  var autoRestarting: Bool = false
  var autoRestartAttempt: Int = 0
  var nextAutoRestartAt: Date? = nil
}

