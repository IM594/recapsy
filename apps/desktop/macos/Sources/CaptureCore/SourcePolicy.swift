import Foundation

/// The only source attributes available before ScreenCaptureKit copies pixels.
/// They come from the final selected `SCWindow`, never from a separate
/// frontmost-app lookup, so policy and the actual capture target cannot drift.
public struct CaptureSourceIdentity: Equatable, Sendable {
    public let applicationName: String
    public let bundleId: String

    public init(applicationName: String, bundleId: String) {
        self.applicationName = applicationName
        self.bundleId = bundleId
    }
}

public enum CaptureSourcePolicyAction: String, Equatable, Sendable {
    case allow = "allow"
    case blockCapture = "block_capture"
    case redactContext = "redact_context"
    case blockOcr = "block_ocr"
}

public struct CaptureSourcePolicyRule: Equatable, Sendable {
    public let id: String
    public let kind: String
    public let scope: String
    public let pattern: String
    public let action: CaptureSourcePolicyAction
    public let enabled: Bool

    public init(
        id: String,
        kind: String,
        scope: String,
        pattern: String,
        action: CaptureSourcePolicyAction,
        enabled: Bool
    ) {
        self.id = id
        self.kind = kind
        self.scope = scope
        self.pattern = pattern
        self.action = action
        self.enabled = enabled
    }
}

public struct CaptureSourcePolicy: Equatable, Sendable {
    public let version: String
    public let paused: Bool
    public let defaultAction: CaptureSourcePolicyAction
    public let rules: [CaptureSourcePolicyRule]

    public init(
        version: String,
        paused: Bool,
        defaultAction: CaptureSourcePolicyAction,
        rules: [CaptureSourcePolicyRule]
    ) {
        self.version = version
        self.paused = paused
        self.defaultAction = defaultAction
        self.rules = rules
    }
}

public struct CaptureSourcePolicyDecision: Equatable, Sendable {
    public let action: CaptureSourcePolicyAction
    public let matchedRuleIds: [String]

    public init(action: CaptureSourcePolicyAction, matchedRuleIds: [String]) {
        self.action = action
        self.matchedRuleIds = matchedRuleIds
    }
}

/// Pure policy reducer shared by the capture engine and its tests. Policy
/// actions are monotonic: a matching `allow` rule cannot weaken a stricter
/// default or another matching rule. Rule patterns are literal values, not
/// regular expressions or globs; that keeps matching stable across Electron
/// and Swift and avoids executing server-provided pattern syntax locally.
public enum CaptureSourcePolicyEvaluator {
    public static func decide(
        policy: CaptureSourcePolicy,
        source: CaptureSourceIdentity?
    ) -> CaptureSourcePolicyDecision {
        guard let source else {
            return CaptureSourcePolicyDecision(action: .blockCapture, matchedRuleIds: [])
        }

        if policy.paused {
            return CaptureSourcePolicyDecision(action: .blockCapture, matchedRuleIds: [])
        }

        var action = policy.defaultAction
        var matchedRuleIds: [String] = []

        for rule in policy.rules where rule.enabled {
            switch match(rule: rule, source: source) {
            case .matched:
                matchedRuleIds.append(rule.id)
                action = stricter(action, rule.action)
            case .unobservableNonAllow:
                return CaptureSourcePolicyDecision(
                    action: .blockCapture,
                    matchedRuleIds: matchedRuleIds
                )
            case .notMatched:
                continue
            }
        }

        return CaptureSourcePolicyDecision(action: action, matchedRuleIds: matchedRuleIds)
    }

    private enum RuleMatch {
        case matched
        case notMatched
        case unobservableNonAllow
    }

    private static func match(rule: CaptureSourcePolicyRule, source: CaptureSourceIdentity) -> RuleMatch {
        switch rule.kind {
        case "bundle_id":
            return rule.pattern == source.bundleId ? .matched : .notMatched
        case "app_name":
            return rule.pattern.caseInsensitiveCompare(source.applicationName) == .orderedSame
                ? .matched
                : .notMatched
        case "pause":
            return .matched
        case "domain", "document_path", "window_title":
            return rule.action == .allow ? .notMatched : .unobservableNonAllow
        default:
            // The protocol validator rejects unknown kinds. Retain fail-closed
            // behavior here in case the helper receives malformed stdin from a
            // process that bypassed that validator.
            return rule.action == .allow ? .notMatched : .unobservableNonAllow
        }
    }

    private static func stricter(
        _ current: CaptureSourcePolicyAction,
        _ candidate: CaptureSourcePolicyAction
    ) -> CaptureSourcePolicyAction {
        return priority(candidate) > priority(current) ? candidate : current
    }

    private static func priority(_ action: CaptureSourcePolicyAction) -> Int {
        switch action {
        case .allow:
            return 0
        case .blockOcr:
            return 1
        case .redactContext:
            return 2
        case .blockCapture:
            return 3
        }
    }
}
