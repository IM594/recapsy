import CryptoKit
import Foundation

/// Optional metadata sampled from direct Accessibility attributes. It is
/// intentionally limited to values that the helper protocol can carry safely;
/// raw AX objects, paths, URLs and temporary Accessibility identifiers never
/// cross this boundary.
public struct CaptureSourceContext: Codable, Equatable, Sendable {
    public struct Window: Codable, Equatable, Sendable {
        public let title: String

        fileprivate init(title: String) {
            self.title = title
        }
    }

    public struct Website: Codable, Equatable, Sendable {
        public let origin: String
        public let host: String

        fileprivate init(origin: String, host: String) {
            self.origin = origin
            self.host = host
        }
    }

    public struct Document: Codable, Equatable, Sendable {
        public let name: String

        fileprivate init(name: String) {
            self.name = name
        }
    }

    public let window: Window?
    public let website: Website?
    public let document: Document?
    /// Stable local-only identity for context comparison. It is deliberately
    /// not added to the capture-result wire contract.
    public let fingerprint: String

    private init(
        window: Window?,
        website: Website?,
        document: Document?,
        fingerprint: String
    ) {
        self.window = window
        self.website = website
        self.document = document
        self.fingerprint = fingerprint
    }

    /// Builds a safe context from raw direct Accessibility values. Invalid or
    /// sensitive values disappear independently, so an unavailable URL never
    /// prevents the app-level capture record from being created.
    public static func make(
        application: CaptureApplicationPayload,
        document: String?,
        url: String?,
        windowTitle: String?
    ) -> CaptureSourceContext? {
        guard let bundleId = normalizedBundleId(application.bundleId) else {
            return nil
        }

        let safeWindow = safeWindowTitle(windowTitle).map(Window.init)
        let safeWebsite = safeWebsite(url)
        let safeDocument = safeDocumentName(document).map(Document.init)
        let fingerprint = contextFingerprint(
            bundleId: bundleId,
            window: safeWindow,
            website: safeWebsite,
            document: safeDocument
        )

        return CaptureSourceContext(
            window: safeWindow,
            website: safeWebsite,
            document: safeDocument,
            fingerprint: fingerprint
        )
    }

    public func payload(
        application: CaptureApplicationPayload,
        observedAt: String,
        policy: CapturePolicyPayload
    ) -> CaptureContextPayload {
        let normalized = CaptureSourceContext.make(
            application: application,
            document: document?.name,
            url: website?.origin,
            windowTitle: window?.title
        )
        let exposesContext = policy.decision != CaptureSourcePolicyAction.redactContext.rawValue
        return CaptureContextPayload(
            app: application,
            observedAt: observedAt,
            window: exposesContext ? normalized?.window.map { CaptureWindowPayload(title: $0.title) } : nil,
            website: exposesContext
                ? normalized?.website.map { CaptureWebsitePayload(origin: $0.origin, host: $0.host) }
                : nil,
            document: exposesContext ? normalized?.document.map { CaptureDocumentPayload(name: $0.name) } : nil,
            policy: policy
        )
    }

    /// Domain rules use hostnames only. Pattern syntax, ports, subdomain globs,
    /// whitespace and trailing dots are not normalized into a match.
    public static func normalizedDomainPattern(_ pattern: String) -> String? {
        guard pattern == pattern.trimmingCharacters(in: .whitespacesAndNewlines) else {
            return nil
        }
        return normalizedHost(pattern)
    }

    private static func safeWindowTitle(_ raw: String?) -> String? {
        guard let value = safeVisibleString(raw, maximumLength: 512) else {
            return nil
        }
        guard !value.contains("/") && !value.contains("\\") && !isPathOrURL(value) else {
            return nil
        }
        return value
    }

    private static func safeDocumentName(_ raw: String?) -> String? {
        guard let raw, !containsControlCharacter(raw) else {
            return nil
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            !trimmed.isEmpty,
            !trimmed.lowercased().hasPrefix("file://"),
            !trimmed.lowercased().hasPrefix("http://"),
            !trimmed.lowercased().hasPrefix("https://"),
            !trimmed.contains("?"),
            !trimmed.contains("#")
        else {
            return nil
        }

        let name = trimmed
            .split(whereSeparator: { $0 == "/" || $0 == "\\" })
            .last
            .map(String.init)
        guard let name = safeVisibleString(name, maximumLength: 512) else {
            return nil
        }
        guard !name.contains("/") && !name.contains("\\") && !isPathOrURL(name) else {
            return nil
        }
        return name
    }

    private static func safeWebsite(_ raw: String?) -> Website? {
        guard let raw, !containsControlCharacter(raw) else {
            return nil
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            !trimmed.isEmpty,
            let components = URLComponents(string: trimmed),
            let scheme = components.scheme?.lowercased(),
            scheme == "http" || scheme == "https",
            components.user == nil,
            components.password == nil,
            components.query == nil,
            components.fragment == nil,
            let host = normalizedHost(components.host),
            components.port == nil ||
                (scheme == "http" && components.port == 80) ||
                (scheme == "https" && components.port == 443)
        else {
            return nil
        }
        return Website(origin: "\(scheme)://\(host)", host: host)
    }

    private static func contextFingerprint(
        bundleId: String,
        window: Window?,
        website: Website?,
        document: Document?
    ) -> String {
        let stableFields = [
            bundleId,
            window?.title.lowercased() ?? "",
            website?.origin ?? "",
            document?.name.lowercased() ?? "",
        ]
        let digest = SHA256.hash(data: Data(stableFields.joined(separator: "\0").utf8))
        return "sha256:" + digest.map { String(format: "%02x", $0) }.joined()
    }

    private static func normalizedBundleId(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            !trimmed.isEmpty,
            trimmed.count <= 256,
            trimmed.range(of: "^[A-Za-z0-9.-]+$", options: .regularExpression) != nil
        else {
            return nil
        }
        return trimmed.lowercased()
    }

    private static func normalizedHost(_ value: String?) -> String? {
        guard let value, !value.isEmpty, value.count <= 253, !containsControlCharacter(value) else {
            return nil
        }
        let normalized = value.lowercased()
        guard
            normalized == normalized.trimmingCharacters(in: .whitespacesAndNewlines),
            !normalized.hasPrefix("."),
            !normalized.hasSuffix("."),
            !normalized.contains(".."),
            normalized.range(of: "^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$", options: .regularExpression) != nil
        else {
            return nil
        }
        return normalized
    }

    private static func safeVisibleString(_ raw: String?, maximumLength: Int) -> String? {
        guard let raw, !containsControlCharacter(raw) else {
            return nil
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            !trimmed.isEmpty,
            trimmed.count <= maximumLength,
            !matches(trimmed, pattern: #"\b(token|secret|password|credential|api[ _-]?key)\b"#),
            !matches(trimmed, pattern: #"\bsk-[A-Za-z0-9_-]{12,}\b"#)
        else {
            return nil
        }
        return trimmed
    }

    private static func isPathOrURL(_ value: String) -> Bool {
        let lowercased = value.lowercased()
        return value.hasPrefix("/") ||
            value.range(of: "^[A-Za-z]:[\\\\/]", options: .regularExpression) != nil ||
            lowercased.hasPrefix("file://") ||
            lowercased.hasPrefix("http://") ||
            lowercased.hasPrefix("https://")
    }

    private static func containsControlCharacter(_ value: String) -> Bool {
        value.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
    }

    private static func matches(_ value: String, pattern: String) -> Bool {
        value.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }
}
