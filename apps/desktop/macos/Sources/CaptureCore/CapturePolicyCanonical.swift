import CryptoKit
import Foundation

public struct CapturePolicyCanonicalRule: Equatable, Sendable {
    public let action: String
    public let enabled: Bool
    public let id: String
    public let kind: String
    public let pattern: String
    public let scope: String

    public init(
        action: String,
        enabled: Bool,
        id: String,
        kind: String,
        pattern: String,
        scope: String
    ) {
        self.action = action
        self.enabled = enabled
        self.id = id
        self.kind = kind
        self.pattern = pattern
        self.scope = scope
    }

    public static func isSupportedText(_ value: String) -> Bool {
        return !value.contains("\0")
    }

    fileprivate var stableKey: Data {
        Data([scope, id, kind, pattern, action, enabled ? "1" : "0"]
            .joined(separator: "\0")
            .utf8)
    }

    fileprivate var jsonObject: [String: Any] {
        [
            "action": action,
            "enabled": enabled,
            "id": id,
            "kind": kind,
            "pattern": pattern,
            "scope": scope,
        ]
    }
}

public struct CapturePolicyCanonicalSnapshot: Equatable, Sendable {
    public let defaultAction: String
    public let paused: Bool
    public let rules: [CapturePolicyCanonicalRule]
    public let version: String

    public init(
        defaultAction: String,
        paused: Bool,
        rules: [CapturePolicyCanonicalRule],
        version: String
    ) {
        self.defaultAction = defaultAction
        self.paused = paused
        self.rules = rules.sorted { left, right in
            left.stableKey.lexicographicallyPrecedes(right.stableKey)
        }
        self.version = version
    }

    public func canonicalData() throws -> Data {
        try JSONSerialization.data(
            withJSONObject: [
                "defaultAction": defaultAction,
                "paused": paused,
                "rules": rules.map(\.jsonObject),
                "version": version,
            ],
            options: [.sortedKeys, .withoutEscapingSlashes]
        )
    }

    public func canonicalJSON() throws -> String {
        let data = try canonicalData()
        guard let json = String(data: data, encoding: .utf8) else {
            throw CapturePolicyCanonicalError.invalidUTF8
        }
        return json
    }

    public func policyHash() throws -> String {
        let digest = SHA256.hash(data: try canonicalData())
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return "sha256:\(hex)"
    }
}

public enum CapturePolicyCanonicalError: Error {
    case invalidUTF8
}
