import Foundation

struct CollectorProcessInfo: Equatable, Identifiable {
  let pid: Int32
  let path: String

  var id: Int32 { pid }
}

struct CollectorProcessDiagnostics: Equatable {
  var lastScanAt: Date? = nil
  var managedPid: Int32? = nil
  var lockPid: Int32? = nil
  var processes: [CollectorProcessInfo] = []

  var autoFixing: Bool = false
  var lastAutoFixAt: Date? = nil
  var lastAutoFixMessage: String? = nil

  var autoRestarting: Bool = false
  var autoRestartAttempt: Int = 0
  var nextAutoRestartAt: Date? = nil

  var relatedCount: Int { processes.count }
  var hasMultipleInstances: Bool { processes.count > 1 }
}

