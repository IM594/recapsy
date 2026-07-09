import XCTest
import Foundation
@testable import CaptureCore

final class AssetPathsTests: XCTestCase {
    func testScreenshotRelativeKeyIsCaptureScopedJpeg() {
        XCTAssertEqual(
            CaptureAsset.screenshotRelativeKey(captureId: "cap-1720000000000-3"),
            "cap-1720000000000-3/screenshot.jpg"
        )
    }

    func testScreenshotFileURLJoinsRootAndKey() {
        let root = URL(fileURLWithPath: "/Users/example/Application Support/captures", isDirectory: true)
        let url = CaptureAsset.screenshotFileURL(assetRoot: root, captureId: "cap-42-1")
        XCTAssertEqual(url.path, "/Users/example/Application Support/captures/cap-42-1/screenshot.jpg")
    }

    func testCaptureDirectoryURLIsCaptureScoped() {
        let root = URL(fileURLWithPath: "/tmp/root", isDirectory: true)
        let dir = CaptureAsset.captureDirectoryURL(assetRoot: root, captureId: "cap-9-2")
        XCTAssertEqual(dir.path, "/tmp/root/cap-9-2")
    }

    func testContentHashIsSha256PrefixedLowerHex() {
        let data = Data("recapsy".utf8)
        let hash = CaptureAsset.contentHash(for: data)
        XCTAssertTrue(hash.hasPrefix("sha256:"))
        let hex = String(hash.dropFirst("sha256:".count))
        XCTAssertEqual(hex.count, 64)
        XCTAssertTrue(hex.allSatisfy { $0.isHexDigit && ($0.isNumber || $0.isLowercase) })
        // Known SHA-256 of the ASCII bytes "recapsy" (computed independently
        // with `shasum -a 256`), so this asserts the value, not just the shape.
        XCTAssertEqual(
            hash,
            "sha256:b01ddbe5a20f9129e40284c4262191ccebc64987983eeb5fca138c588bdbd5b2"
        )
    }

    func testCaptureIdUsesOnlyRelativeKeySafeCharacters() {
        let id = CaptureIdGenerator.make(epochMilliseconds: 1_720_000_000_000, counter: 7)
        XCTAssertEqual(id, "cap-1720000000000-7")
        // Must survive the sync layer's opaque-ref / redaction checks: no slash,
        // no absolute-path prefix, no `file://`, no whitespace.
        XCTAssertFalse(id.contains("/"))
        XCTAssertFalse(id.hasPrefix("/"))
        XCTAssertFalse(id.contains("file://"))
        XCTAssertTrue(id.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" })
    }
}

final class ProtocolEncodingTests: XCTestCase {
    private func decode(_ line: String) throws -> [String: Any] {
        XCTAssertTrue(line.hasSuffix("\n"), "NDJSON line must end with a newline")
        let jsonText = String(line.dropLast())
        let object = try JSONSerialization.jsonObject(with: Data(jsonText.utf8))
        return try XCTUnwrap(object as? [String: Any])
    }

    func testEnvelopeCarriesProtocolVersionAndExplicitNullCorrelationId() throws {
        let envelope = HelperEnvelope(
            messageId: "cap-msg-1",
            correlationId: nil,
            sentAt: "2026-07-09T00:00:00.000Z",
            type: "helper.hello",
            payload: HelloPayload(
                helperVersion: "recapsy-capture/0.1.0",
                pid: 4242,
                capabilities: HelperCapabilities(capture: true, permissions: true, mock: false)
            )
        )
        let line = try encodeEnvelopeLine(envelope)
        // correlationId must be present as JSON null (absent would fail the TS
        // validator), so the raw text must contain the null literal.
        XCTAssertTrue(line.contains("\"correlationId\":null"))

        let object = try decode(line)
        XCTAssertEqual(object["protocolVersion"] as? String, "recapsy.capture-helper")
        XCTAssertEqual(object["type"] as? String, "helper.hello")
        XCTAssertTrue(object.keys.contains("correlationId"))
        XCTAssertNil(object["correlationId"] as? String)

        let payload = try XCTUnwrap(object["payload"] as? [String: Any])
        XCTAssertEqual(payload["pid"] as? Int, 4242)
        let capabilities = try XCTUnwrap(payload["capabilities"] as? [String: Any])
        XCTAssertEqual(capabilities["mock"] as? Bool, false)
        XCTAssertEqual(capabilities["capture"] as? Bool, true)
        XCTAssertEqual(capabilities["permissions"] as? Bool, true)
    }

    func testOptionalPayloadFieldIsOmittedNotNulled() throws {
        let envelope = HelperEnvelope(
            messageId: "cap-msg-2",
            correlationId: nil,
            sentAt: "2026-07-09T00:00:00.000Z",
            type: "helper.status",
            payload: StatusPayload(status: "ready", reason: nil)
        )
        let line = try encodeEnvelopeLine(envelope)
        // hasOnlyKeys + the field guard reject a `null` reason; it must be
        // absent entirely.
        XCTAssertFalse(line.contains("reason"))
        let payload = try XCTUnwrap(try decode(line)["payload"] as? [String: Any])
        XCTAssertEqual(payload["status"] as? String, "ready")
        XCTAssertFalse(payload.keys.contains("reason"))
    }

    func testOptionalPayloadFieldPresentWhenSet() throws {
        let envelope = HelperEnvelope(
            messageId: "cap-msg-3",
            correlationId: nil,
            sentAt: "2026-07-09T00:00:00.000Z",
            type: "helper.status",
            payload: StatusPayload(status: "paused", reason: "user_paused")
        )
        let payload = try XCTUnwrap(try decode(try encodeEnvelopeLine(envelope))["payload"] as? [String: Any])
        XCTAssertEqual(payload["reason"] as? String, "user_paused")
    }

    func testCaptureResultKeepsRelativeRefSlashUnescaped() throws {
        let asset = CaptureAssetPayload(
            role: "screenshot",
            ref: "cap-100-1/screenshot.jpg",
            hash: "sha256:abc",
            mimeType: "image/jpeg",
            sizeBytes: 204800
        )
        let manifest = CaptureAssetPayload(
            role: "manifest",
            ref: "cap-100-1/manifest.json",
            hash: "sha256:abc",
            mimeType: "application/json",
            sizeBytes: 0
        )
        let payload = CaptureResultPayload(
            captureId: "cap-100-1",
            observedAt: "2026-07-09T00:00:00.000Z",
            manifest: manifest,
            assets: [asset],
            context: CaptureContextPayload(
                observedAt: "2026-07-09T00:00:00.000Z",
                policy: CapturePolicyPayload(version: "policy-1", decision: "allow")
            )
        )
        let envelope = HelperEnvelope(
            messageId: "cap-msg-4",
            correlationId: "corr-1",
            sentAt: "2026-07-09T00:00:00.000Z",
            type: "capture.result",
            payload: payload
        )
        let line = try encodeEnvelopeLine(envelope)
        // The relative key must be byte-identical to what the sync loop joins
        // onto the asset root — no escaped `\/`.
        XCTAssertTrue(line.contains("cap-100-1/screenshot.jpg"))
        XCTAssertFalse(line.contains("screenshot.jpg\\/"))
        XCTAssertFalse(line.contains("\\/"))

        let object = try decode(line)
        XCTAssertEqual(object["correlationId"] as? String, "corr-1")
        let decodedPayload = try XCTUnwrap(object["payload"] as? [String: Any])
        let assets = try XCTUnwrap(decodedPayload["assets"] as? [[String: Any]])
        XCTAssertEqual(assets.count, 1)
        XCTAssertEqual(assets[0]["ref"] as? String, "cap-100-1/screenshot.jpg")
        XCTAssertEqual(assets[0]["role"] as? String, "screenshot")
        let context = try XCTUnwrap(decodedPayload["context"] as? [String: Any])
        let policy = try XCTUnwrap(context["policy"] as? [String: Any])
        XCTAssertEqual(policy["decision"] as? String, "allow")
        XCTAssertEqual(policy["version"] as? String, "policy-1")
    }
}
