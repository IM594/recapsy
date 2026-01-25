import Foundation

struct CollectorPermissionDiagnostics: Equatable {
  var lastCheckedAt: Date? = nil
  var checking: Bool = false

  var checkedExecutable: String? = nil
  var screenRecordingGranted: Bool? = nil
  var accessibilityGranted: Bool? = nil
  var lastErrorMessage: String? = nil

  var isScreenRecordingMissing: Bool { screenRecordingGranted == false }
  var isAccessibilityMissing: Bool { accessibilityGranted == false }
  var hasAnyMissing: Bool { isScreenRecordingMissing || isAccessibilityMissing }
}

