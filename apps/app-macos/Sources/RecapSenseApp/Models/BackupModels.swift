import Foundation

struct BackupManifest: Codable {
  var schemaVersion: Int
  var exportedAt: String
  var includesMedia: Bool
  var notes: String?
}

struct BackupImportResult: Equatable {
  var backupRoot: URL
  var dataDir: URL
  var preImportDbBackupPath: URL?
  var restoredMedia: Bool
  var notes: String?
}
