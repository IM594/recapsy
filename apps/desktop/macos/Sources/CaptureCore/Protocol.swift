import Foundation

/// Wire contract shared with `apps/desktop/src/helper/protocol/types.ts`. Every field
/// name, enum value and optionality here is mirrored 1:1 against that file's
/// runtime validators (`hasOnlyKeys`, `isOneOf`, the per-type payload guards).
/// The guiding rule the TS side enforces and this file must respect:
///   - optional payload fields are *omitted* when absent (never emitted as
///     `null`), because `hasOnlyKeys` + the field guards reject a `null`-valued
///     optional; Swift's synthesized `Codable` omits `nil` optionals, which is
///     exactly what we want for those.
///   - the envelope's `correlationId` is the one exception: it must be present
///     as JSON `null` when there is no correlation, so `HelperEnvelope` encodes
///     it explicitly rather than omitting it.
public enum HelperProtocol {
    public static let version = "recapsy.capture-helper"
}

// MARK: - Envelope

/// NDJSON envelope. `correlationId` is encoded explicitly (JSON `null` when
/// `nil`) because the TS validator treats an absent `correlationId` as a schema
/// error, while a present `null` is accepted.
public struct HelperEnvelope<Payload: Encodable>: Encodable {
    public let protocolVersion: String
    public let messageId: String
    public let correlationId: String?
    public let sentAt: String
    public let type: String
    public let payload: Payload

    public init(
        messageId: String,
        correlationId: String?,
        sentAt: String,
        type: String,
        payload: Payload
    ) {
        self.protocolVersion = HelperProtocol.version
        self.messageId = messageId
        self.correlationId = correlationId
        self.sentAt = sentAt
        self.type = type
        self.payload = payload
    }

    private enum CodingKeys: String, CodingKey {
        case protocolVersion, messageId, correlationId, sentAt, type, payload
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(protocolVersion, forKey: .protocolVersion)
        try container.encode(messageId, forKey: .messageId)
        // `encode` (not `encodeIfPresent`) so `nil` is written as JSON `null`.
        try container.encode(correlationId, forKey: .correlationId)
        try container.encode(sentAt, forKey: .sentAt)
        try container.encode(type, forKey: .type)
        try container.encode(payload, forKey: .payload)
    }
}

// MARK: - helper -> main payloads

public struct HelperCapabilities: Encodable {
    public let capture: Bool
    public let permissions: Bool
    public let mock: Bool

    public init(capture: Bool, permissions: Bool, mock: Bool) {
        self.capture = capture
        self.permissions = permissions
        self.mock = mock
    }
}

public struct HelloPayload: Encodable {
    public let helperVersion: String
    public let pid: Int
    public let capabilities: HelperCapabilities

    public init(helperVersion: String, pid: Int, capabilities: HelperCapabilities) {
        self.helperVersion = helperVersion
        self.pid = pid
        self.capabilities = capabilities
    }
}

public struct StatusPayload: Encodable {
    public let status: String
    public let reason: String?

    public init(status: String, reason: String? = nil) {
        self.status = status
        self.reason = reason
    }
}

/// Confirms that the helper has accepted the exact canonical policy supplied
/// by Electron. The correlation id lives on the surrounding envelope so the
/// process client can reject stale or mismatched acknowledgements safely.
public struct PolicyAppliedPayload: Encodable {
    public let policyHash: String
    public let policyVersion: String

    public init(policyHash: String, policyVersion: String) {
        self.policyHash = policyHash
        self.policyVersion = policyVersion
    }
}

public struct PermissionStatusPayload: Encodable {
    public let screenCapture: String
    public let accessibility: String
    public let observedAt: String

    public init(screenCapture: String, accessibility: String, observedAt: String) {
        self.screenCapture = screenCapture
        self.accessibility = accessibility
        self.observedAt = observedAt
    }
}

public struct HeartbeatPayload: Encodable {
    public let sequence: Int
    public let status: String

    public init(sequence: Int, status: String) {
        self.sequence = sequence
        self.status = status
    }
}

public struct ExitingPayload: Encodable {
    public let reason: String
    public let code: Int

    public init(reason: String, code: Int) {
        self.reason = reason
        self.code = code
    }
}

public struct CaptureErrorPayload: Encodable {
    public let captureId: String?
    public let code: String
    public let message: String

    public init(captureId: String? = nil, code: String, message: String) {
        self.captureId = captureId
        self.code = code
        self.message = message
    }
}

public enum CaptureSkippedReason: String, Encodable {
    case paused
    case policyDenied = "policy_denied"
    case duplicate
    case blank
    case lowInformation = "low_information"
    case secureInput = "secure_input"
    case privateContext = "private_context"
}

public struct CaptureSkippedPayload: Encodable {
    public let captureId: String
    public let reason: CaptureSkippedReason
    public let observedAt: String

    public init(captureId: String, reason: CaptureSkippedReason, observedAt: String) {
        self.captureId = captureId
        self.reason = reason
        self.observedAt = observedAt
    }
}

public struct CaptureAssetPayload: Codable {
    public let role: String
    public let ref: String
    public let hash: String
    public let mimeType: String
    public let sizeBytes: Int

    public init(role: String, ref: String, hash: String, mimeType: String, sizeBytes: Int) {
        self.role = role
        self.ref = ref
        self.hash = hash
        self.mimeType = mimeType
        self.sizeBytes = sizeBytes
    }
}

public struct CapturePolicyPayload: Codable {
    public let version: String
    public let decision: String

    public init(version: String, decision: String) {
        self.version = version
        self.decision = decision
    }
}

public struct CaptureApplicationPayload: Codable, Equatable {
    public let name: String
    public let bundleId: String

    public init(name: String, bundleId: String) {
        self.name = name
        self.bundleId = bundleId
    }

    /// Converts the narrow app-level metadata exposed by macOS into the helper
    /// protocol shape. Missing or unsafe values are omitted rather than causing
    /// a whole capture envelope to fail validation in the Electron process.
    public static func fromRuntimeMetadata(name: String?, bundleId: String?) -> CaptureApplicationPayload? {
        guard
            let safeName = normalizedName(name),
            let safeBundleId = normalizedBundleId(bundleId)
        else {
            return nil
        }
        return CaptureApplicationPayload(name: safeName, bundleId: safeBundleId)
    }

    private static func normalizedName(_ value: String?) -> String? {
        guard let value else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            !trimmed.isEmpty,
            trimmed.count <= 256,
            !trimmed.hasPrefix("/"),
            !trimmed.lowercased().hasPrefix("file://"),
            !matches(trimmed, pattern: #"\b(token|secret|password|credential|api[ _-]?key)\b"#),
            !matches(
                trimmed,
                pattern: #"https?://\S+[?&](token|auth|access_token|refresh_token|secret|password|credential|api[_-]?key)="#
            )
        else {
            return nil
        }
        return trimmed
    }

    private static func normalizedBundleId(_ value: String?) -> String? {
        guard let value else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            !trimmed.isEmpty,
            trimmed.count <= 256,
            matches(trimmed, pattern: "^[A-Za-z0-9.-]+$", caseInsensitive: false)
        else {
            return nil
        }
        return trimmed
    }

    private static func matches(
        _ value: String,
        pattern: String,
        caseInsensitive: Bool = true
    ) -> Bool {
        var options: String.CompareOptions = [.regularExpression]
        if caseInsensitive {
            options.insert(.caseInsensitive)
        }
        return value.range(of: pattern, options: options) != nil
    }
}

public struct CaptureContextPayload: Codable {
    public let app: CaptureApplicationPayload?
    public let observedAt: String
    public let policy: CapturePolicyPayload

    public init(
        app: CaptureApplicationPayload? = nil,
        observedAt: String,
        policy: CapturePolicyPayload
    ) {
        self.app = app
        self.observedAt = observedAt
        self.policy = policy
    }
}

public struct CaptureResultPayload: Codable {
    public let captureId: String
    public let observedAt: String
    public let manifest: CaptureAssetPayload
    public let assets: [CaptureAssetPayload]
    public let context: CaptureContextPayload

    public init(
        captureId: String,
        observedAt: String,
        manifest: CaptureAssetPayload,
        assets: [CaptureAssetPayload],
        context: CaptureContextPayload
    ) {
        self.captureId = captureId
        self.observedAt = observedAt
        self.manifest = manifest
        self.assets = assets
        self.context = context
    }
}

// MARK: - Encoding

public enum HelperEncodingError: Error {
    case notUtf8
}

/// Pure NDJSON line encoder: one JSON object + trailing `\n`, matching
/// `encodeHelperEnvelope` in `protocol.ts`. `sortedKeys` makes output
/// deterministic so unit tests can assert on the exact string. `withoutEscapingSlashes`
/// keeps relative refs such as `<captureId>/screenshot.webp` readable and, more
/// importantly, byte-identical to the relative key the sync loop joins onto the
/// asset root.
public func encodeEnvelopeLine<Payload: Encodable>(
    _ envelope: HelperEnvelope<Payload>
) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let data = try encoder.encode(envelope)
    guard let json = String(data: data, encoding: .utf8) else {
        throw HelperEncodingError.notUtf8
    }
    return json + "\n"
}
