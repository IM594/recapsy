import Foundation

struct BackupManifest: Codable {
  var schemaVersion: Int
  var exportedAt: String
  var includesMedia: Bool
  var notes: String?
}

