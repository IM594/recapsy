import Foundation

struct FrontmostAppInfo: Equatable {
  let pid: pid_t
  let bundleId: String?
  let name: String?
  let activatedAt: Date

  var displayName: String {
    let trimmedName = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !trimmedName.isEmpty { return trimmedName }

    let trimmedBundleId = bundleId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !trimmedBundleId.isEmpty { return trimmedBundleId }

    return "未知应用"
  }
}

