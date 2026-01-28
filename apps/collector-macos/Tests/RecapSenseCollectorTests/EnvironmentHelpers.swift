import Foundation

func withEnvVar(_ key: String, _ value: String?, _ body: () throws -> Void) rethrows {
  let previous = getenv(key).map { String(cString: $0) }
  if let value {
    setenv(key, value, 1)
  } else {
    unsetenv(key)
  }

  defer {
    if let previous {
      setenv(key, previous, 1)
    } else {
      unsetenv(key)
    }
  }

  try body()
}

func makeTempDir(prefix: String) throws -> URL {
  let base = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
  let dir = base.appendingPathComponent("\(prefix)-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  return dir
}

