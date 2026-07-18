import XCTest
import Foundation
@testable import CaptureCore

final class AssetPathsTests: XCTestCase {
    func testScreenshotRelativeKeyIsCaptureScopedWebp() {
        XCTAssertEqual(
            CaptureAsset.screenshotRelativeKey(captureId: "cap-1720000000000-3"),
            "cap-1720000000000-3/screenshot.webp"
        )
    }

    func testScreenshotMimeTypeIsWebp() {
        XCTAssertEqual(CaptureAsset.screenshotMimeType, "image/webp")
    }

    func testScreenshotFileURLJoinsRootAndKey() {
        let root = URL(fileURLWithPath: "/Users/example/Application Support/captures", isDirectory: true)
        let url = CaptureAsset.screenshotFileURL(assetRoot: root, captureId: "cap-42-1")
        XCTAssertEqual(url.path, "/Users/example/Application Support/captures/cap-42-1/screenshot.webp")
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

final class CaptureReceiptTests: XCTestCase {
    func testReceiptPromotesStagedScreenshotAndReplaysPayload() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("recapsy-receipt-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let captureId = "cap-receipt-1"
        let image = Data("screen-bytes".utf8)
        let hash = CaptureAsset.contentHash(for: image)
        let payload = CaptureResultPayload(
            captureId: captureId,
            observedAt: "2026-07-18T00:00:00.000Z",
            manifest: CaptureAssetPayload(
                role: "manifest",
                ref: "\(captureId)/manifest.json",
                hash: hash,
                mimeType: "application/json",
                sizeBytes: 0
            ),
            assets: [CaptureAssetPayload(
                role: "screenshot",
                ref: CaptureAsset.screenshotRelativeKey(captureId: captureId),
                hash: hash,
                mimeType: CaptureAsset.screenshotMimeType,
                sizeBytes: image.count
            )],
            context: CaptureContextPayload(
                app: CaptureApplicationPayload(name: "Fixture App", bundleId: "one.recapsy.fixture"),
                observedAt: "2026-07-18T00:00:00.000Z",
                policy: CapturePolicyPayload(version: "policy-1", decision: "allow")
            )
        )
        let receipt = CaptureReceipt(
            workspaceId: "workspace-1",
            deviceId: "device-1",
            payload: payload,
            screenshotHash: hash,
            screenshotSizeBytes: image.count
        )

        let staged = CaptureReceiptStore.stagedScreenshotFileURL(assetRoot: root, captureId: captureId)
        try FileManager.default.createDirectory(
            at: CaptureAsset.captureDirectoryURL(assetRoot: root, captureId: captureId),
            withIntermediateDirectories: true
        )
        try image.write(to: staged, options: .atomic)
        try CaptureReceiptStore.write(receipt, assetRoot: root, captureId: captureId)

        let recovered = try CaptureReceiptStore.recover(receipt, assetRoot: root)
        XCTAssertEqual(recovered.captureId, captureId)
        XCTAssertTrue(
            FileManager.default.fileExists(
                atPath: CaptureAsset.screenshotFileURL(assetRoot: root, captureId: captureId).path
            )
        )
        XCTAssertFalse(FileManager.default.fileExists(atPath: staged.path))

        CaptureReceiptStore.removeReceipt(assetRoot: root, captureId: captureId)
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: CaptureReceiptStore.receiptURL(assetRoot: root, captureId: captureId).path
            )
        )
    }

    func testReceiptListingIsScopedToDirectoriesWithReceipts() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("recapsy-receipt-list-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let withReceipt = CaptureAsset.captureDirectoryURL(assetRoot: root, captureId: "cap-a")
        let withoutReceipt = CaptureAsset.captureDirectoryURL(assetRoot: root, captureId: "cap-b")
        try FileManager.default.createDirectory(at: withReceipt, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: withoutReceipt, withIntermediateDirectories: true)
        try Data("{}".utf8).write(
            to: withReceipt.appendingPathComponent(CaptureReceiptStore.receiptFileName),
            options: .atomic
        )

        XCTAssertEqual(CaptureReceiptStore.listCaptureIds(assetRoot: root), ["cap-a"])
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

    func testPolicyAppliedPayloadPreservesVersionHashAndCorrelation() throws {
        let envelope = HelperEnvelope(
            messageId: "cap-msg-policy-1",
            correlationId: "policy-config-1",
            sentAt: "2026-07-18T00:00:00.000Z",
            type: "helper.policy_applied",
            payload: PolicyAppliedPayload(
                policyHash: "sha256:" + String(repeating: "a", count: 64),
                policyVersion: "policy-1"
            )
        )

        let object = try decode(try encodeEnvelopeLine(envelope))
        XCTAssertEqual(object["correlationId"] as? String, "policy-config-1")
        let payload = try XCTUnwrap(object["payload"] as? [String: Any])
        XCTAssertEqual(payload["policyVersion"] as? String, "policy-1")
        XCTAssertEqual(payload["policyHash"] as? String, "sha256:" + String(repeating: "a", count: 64))
    }

    func testCaptureSkippedPayloadHasNoAssetOrContextFields() throws {
        let envelope = HelperEnvelope(
            messageId: "cap-msg-skipped-1",
            correlationId: nil,
            sentAt: "2026-07-18T00:00:00.000Z",
            type: "capture.skipped",
            payload: CaptureSkippedPayload(
                captureId: "cap-1",
                reason: .policyDenied,
                observedAt: "2026-07-18T00:00:00.000Z"
            )
        )

        let payload = try XCTUnwrap(try decode(try encodeEnvelopeLine(envelope))["payload"] as? [String: Any])
        XCTAssertEqual(payload["captureId"] as? String, "cap-1")
        XCTAssertEqual(payload["reason"] as? String, "policy_denied")
        XCTAssertFalse(payload.keys.contains("assets"))
        XCTAssertFalse(payload.keys.contains("context"))
    }

    func testCaptureResultKeepsRelativeRefSlashUnescaped() throws {
        let asset = CaptureAssetPayload(
            role: "screenshot",
            ref: "cap-100-1/screenshot.webp",
            hash: "sha256:abc",
            mimeType: "image/webp",
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
        XCTAssertTrue(line.contains("cap-100-1/screenshot.webp"))
        XCTAssertFalse(line.contains("screenshot.webp\\/"))
        XCTAssertFalse(line.contains("\\/"))

        let object = try decode(line)
        XCTAssertEqual(object["correlationId"] as? String, "corr-1")
        let decodedPayload = try XCTUnwrap(object["payload"] as? [String: Any])
        let assets = try XCTUnwrap(decodedPayload["assets"] as? [[String: Any]])
        XCTAssertEqual(assets.count, 1)
        XCTAssertEqual(assets[0]["ref"] as? String, "cap-100-1/screenshot.webp")
        XCTAssertEqual(assets[0]["role"] as? String, "screenshot")
        let context = try XCTUnwrap(decodedPayload["context"] as? [String: Any])
        let policy = try XCTUnwrap(context["policy"] as? [String: Any])
        XCTAssertEqual(policy["decision"] as? String, "allow")
        XCTAssertEqual(policy["version"] as? String, "policy-1")
    }

    func testCaptureResultIncludesSafeCapturedApplicationIdentity() throws {
        let context = CaptureContextPayload(
            app: CaptureApplicationPayload.fromRuntimeMetadata(
                name: "Google Chrome",
                bundleId: "com.google.Chrome"
            ),
            observedAt: "2026-07-17T12:00:00.000Z",
            policy: CapturePolicyPayload(version: "policy-1", decision: "allow")
        )
        let envelope = HelperEnvelope(
            messageId: "cap-msg-app-1",
            correlationId: nil,
            sentAt: "2026-07-17T12:00:00.000Z",
            type: "capture.result",
            payload: context
        )

        let payload = try XCTUnwrap(try decode(try encodeEnvelopeLine(envelope))["payload"] as? [String: Any])
        let app = try XCTUnwrap(payload["app"] as? [String: Any])
        XCTAssertEqual(app["name"] as? String, "Google Chrome")
        XCTAssertEqual(app["bundleId"] as? String, "com.google.Chrome")
    }

    func testCaptureApplicationIdentityOmitsIncompleteAndUnsafeMetadata() {
        XCTAssertNil(CaptureApplicationPayload.fromRuntimeMetadata(name: nil, bundleId: "com.google.Chrome"))
        XCTAssertNil(CaptureApplicationPayload.fromRuntimeMetadata(name: "Chrome", bundleId: nil))
        XCTAssertNil(
            CaptureApplicationPayload.fromRuntimeMetadata(
                name: "/Applications/Chrome.app",
                bundleId: "com.google.Chrome"
            )
        )
        XCTAssertNil(
            CaptureApplicationPayload.fromRuntimeMetadata(
                name: "Secret Dashboard",
                bundleId: "com.example.dashboard"
            )
        )
    }
}

final class ActiveWindowSelectorTests: XCTestCase {
    private func window(
        id: Int,
        pid: Int,
        layer: Int = 0,
        onScreen: Bool = true,
        width: Double = 1200,
        height: Double = 800,
        titled: Bool = true
    ) -> CaptureWindowInfo {
        return CaptureWindowInfo(
            windowId: id,
            ownerProcessId: pid,
            layer: layer,
            isOnScreen: onScreen,
            width: width,
            height: height,
            hasTitle: titled
        )
    }

    func testReturnsNilWhenNoWindowBelongsToFrontmostApp() {
        let windows = [window(id: 1, pid: 999), window(id: 2, pid: 999)]
        XCTAssertNil(ActiveWindowSelector.selectWindowId(windows: windows, frontmostProcessId: 42))
    }

    func testReturnsNilWhenFrontmostAppHasNoOnScreenWindow() {
        // Finder-desktop-like case: the app is frontmost but owns nothing
        // capturable — must skip, not pick.
        let windows = [window(id: 1, pid: 42, onScreen: false)]
        XCTAssertNil(ActiveWindowSelector.selectWindowId(windows: windows, frontmostProcessId: 42))
    }

    func testIgnoresNonZeroLayerAndTinyWindows() {
        let windows = [
            window(id: 1, pid: 42, layer: 25),           // status-item layer
            window(id: 2, pid: 42, width: 80, height: 60), // sub-100 floor
        ]
        XCTAssertNil(ActiveWindowSelector.selectWindowId(windows: windows, frontmostProcessId: 42))
    }

    func testPicksLargestTitledWindowOfFrontmostApp() {
        let windows = [
            window(id: 1, pid: 7, width: 400, height: 300),
            window(id: 2, pid: 42, width: 800, height: 600),   // frontmost, medium
            window(id: 3, pid: 42, width: 1600, height: 1000),  // frontmost, largest
            window(id: 4, pid: 42, width: 500, height: 500, titled: false),
        ]
        XCTAssertEqual(
            ActiveWindowSelector.selectWindowId(windows: windows, frontmostProcessId: 42),
            3
        )
    }

    func testPrefersTitledWindowsEvenWhenAnUntitledOneIsLarger() {
        let windows = [
            window(id: 1, pid: 42, width: 900, height: 700, titled: true),
            window(id: 2, pid: 42, width: 1600, height: 1200, titled: false),
        ]
        XCTAssertEqual(
            ActiveWindowSelector.selectWindowId(windows: windows, frontmostProcessId: 42),
            1
        )
    }

    func testFallsBackToUntitledWhenNoTitledCandidate() {
        let windows = [
            window(id: 5, pid: 42, width: 900, height: 700, titled: false),
            window(id: 6, pid: 42, width: 1200, height: 800, titled: false),
        ]
        XCTAssertEqual(
            ActiveWindowSelector.selectWindowId(windows: windows, frontmostProcessId: 42),
            6
        )
    }

    func testEqualAreaTieBreaksToLowerWindowId() {
        let windows = [
            window(id: 9, pid: 42, width: 1000, height: 1000),
            window(id: 4, pid: 42, width: 1000, height: 1000),
        ]
        XCTAssertEqual(
            ActiveWindowSelector.selectWindowId(windows: windows, frontmostProcessId: 42),
            4
        )
    }

    func testTopmostCapturableSkipsNonQualifyingThenPicksFirst() {
        // Front-to-back: non-capturable junk, then the first real window.
        let windows = [
            window(id: 1, pid: 100, width: 80, height: 60),
            window(id: 2, pid: 100, layer: 25),
            window(id: 3, pid: 100, onScreen: false),
            window(id: 4, pid: 200, width: 1920, height: 1055),
            window(id: 5, pid: 300, width: 800, height: 600),
        ]
        XCTAssertEqual(
            ActiveWindowSelector.selectTopmostCapturableWindowId(windowsFrontToBack: windows),
            4
        )
    }

    func testTopmostCapturableExcludesOwnerPids() {
        let windows = [
            window(id: 1, pid: 50, width: 1920, height: 1055),
            window(id: 2, pid: 200, width: 800, height: 600),
        ]
        XCTAssertEqual(
            ActiveWindowSelector.selectTopmostCapturableWindowId(
                windowsFrontToBack: windows,
                excludingOwnerProcessIds: [50]
            ),
            2
        )
    }

    func testVerifiedSelectionFallsBackToMatchingProcessOnly() {
        let primary = [window(id: 1, pid: 999)]
        let fallback = [
            window(id: 2, pid: 999, width: 1920, height: 1055),
            window(id: 3, pid: 42, width: 1200, height: 800),
        ]

        XCTAssertEqual(
            ActiveWindowSelector.selectVerifiedWindowId(
                primaryWindows: primary,
                fallbackWindows: fallback,
                frontmostProcessId: 42
            ),
            3
        )
    }

    func testVerifiedSelectionNeverFallsBackToAnotherApplication() {
        let primary = [window(id: 1, pid: 999)]
        let fallback = [window(id: 2, pid: 999, width: 1920, height: 1055)]

        XCTAssertNil(
            ActiveWindowSelector.selectVerifiedWindowId(
                primaryWindows: primary,
                fallbackWindows: fallback,
                frontmostProcessId: 42
            )
        )
    }
}

final class CaptureSourcePolicyTests: XCTestCase {
    private func rule(
        id: String,
        kind: String,
        pattern: String,
        action: CaptureSourcePolicyAction,
        enabled: Bool = true
    ) -> CaptureSourcePolicyRule {
        return CaptureSourcePolicyRule(
            id: id,
            kind: kind,
            scope: "workspace_default",
            pattern: pattern,
            action: action,
            enabled: enabled
        )
    }

    private func policy(
        defaultAction: CaptureSourcePolicyAction = .allow,
        paused: Bool = false,
        rules: [CaptureSourcePolicyRule] = []
    ) -> CaptureSourcePolicy {
        return CaptureSourcePolicy(
            version: "policy-1",
            paused: paused,
            defaultAction: defaultAction,
            rules: rules
        )
    }

    private let safari = CaptureSourceIdentity(
        applicationName: "Safari",
        bundleId: "com.apple.Safari"
    )

    func testMissingFinalWindowIdentityFailsClosed() {
        let decision = CaptureSourcePolicyEvaluator.decide(policy: policy(), source: nil)
        XCTAssertEqual(decision.action, .blockCapture)
    }

    func testExactBundleRuleBlocksBeforeScreenshotEncoding() {
        let decision = CaptureSourcePolicyEvaluator.decide(
            policy: policy(rules: [
                rule(
                    id: "block-safari",
                    kind: "bundle_id",
                    pattern: "com.apple.Safari",
                    action: .blockCapture
                )
            ]),
            source: safari
        )

        XCTAssertEqual(decision.action, .blockCapture)
        XCTAssertEqual(decision.matchedRuleIds, ["block-safari"])
    }

    func testAllowRuleCannotLoosenEarlierBlockAndRedactionOutranksOcrBlock() {
        let blocked = CaptureSourcePolicyEvaluator.decide(
            policy: policy(rules: [
                rule(
                    id: "hard-block",
                    kind: "bundle_id",
                    pattern: "com.apple.Safari",
                    action: .blockCapture
                ),
                rule(
                    id: "attempted-allow",
                    kind: "bundle_id",
                    pattern: "com.apple.Safari",
                    action: .allow
                )
            ]),
            source: safari
        )
        XCTAssertEqual(blocked.action, .blockCapture)

        let redacted = CaptureSourcePolicyEvaluator.decide(
            policy: policy(rules: [
                rule(
                    id: "no-ocr",
                    kind: "app_name",
                    pattern: "Safari",
                    action: .blockOcr
                ),
                rule(
                    id: "redact",
                    kind: "app_name",
                    pattern: "Safari",
                    action: .redactContext
                )
            ]),
            source: safari
        )
        XCTAssertEqual(redacted.action, .redactContext)
    }

    func testUnobservableNonAllowRuleFailsClosedInsteadOfBeingSilentlyIgnored() {
        let decision = CaptureSourcePolicyEvaluator.decide(
            policy: policy(rules: [
                rule(
                    id: "domain-not-available",
                    kind: "domain",
                    pattern: "private.example.test",
                    action: .blockOcr
                )
            ]),
            source: safari
        )

        XCTAssertEqual(decision.action, .blockCapture)
    }
}

final class CaptureFrameEconomyTests: XCTestCase {
    private enum FixtureError: Error {
        case notAccepted
    }

    private let sameContext = CaptureFrameContext(
        bundleId: "com.apple.Safari",
        windowId: 101
    )

    private func evaluate(
        _ luminance: [UInt8],
        context: CaptureFrameContext? = nil,
        previous: CaptureFrameFingerprint? = nil
    ) -> CaptureFrameEconomyDecision {
        return CaptureFrameEconomy.evaluate(
            luminance: luminance,
            width: 8,
            height: 6,
            context: context ?? sameContext,
            previous: previous
        )
    }

    private func acceptedFingerprint(_ decision: CaptureFrameEconomyDecision) throws -> CaptureFrameFingerprint {
        guard case let .accept(fingerprint) = decision else {
            XCTFail("Expected the fixture to be admitted, got \(decision).")
            throw FixtureError.notAccepted
        }
        return fingerprint
    }

    private struct CalibrationFixture {
        let name: String
        let luminance: [UInt8]
        let shouldAdmit: Bool
    }

    /// Downsampled luminance corpus representing the screen classes that drive
    /// the admission decision: blank pages, loading/flat UI, light documents,
    /// dark terminals, and small visible text changes. Keeping the corpus in
    /// source makes the threshold reviewable and deterministic in CI; each
    /// fixture is a 48-pixel sample taken before WebP encoding, matching the
    /// production sampler's contract.
    private let calibrationCorpus: [CalibrationFixture] = [
        CalibrationFixture(name: "white-page", luminance: Array(repeating: 255, count: 48), shouldAdmit: false),
        CalibrationFixture(name: "dark-page", luminance: Array(repeating: 3, count: 48), shouldAdmit: false),
        CalibrationFixture(name: "flat-loading", luminance: Array(repeating: 128, count: 48), shouldAdmit: false),
        CalibrationFixture(name: "light-document", luminance: CaptureFrameEconomyTests.glyph(base: 245, ink: 25, indices: [10, 11, 18, 19, 26, 27]), shouldAdmit: true),
        CalibrationFixture(name: "dark-terminal", luminance: CaptureFrameEconomyTests.glyph(base: 24, ink: 220, indices: [4, 5, 12, 13, 20, 21, 28, 29]), shouldAdmit: true),
        CalibrationFixture(name: "editor-with-toolbar", luminance: CaptureFrameEconomyTests.glyph(base: 214, ink: 62, indices: [0, 1, 2, 8, 9, 10, 25, 26, 33, 34, 41, 42]), shouldAdmit: true),
    ]

    private static func glyph(base: UInt8, ink: UInt8, indices: [Int]) -> [UInt8] {
        var luminance = Array(repeating: base, count: 48)
        for index in indices {
            luminance[index] = ink
        }
        return luminance
    }

    private func visibleGlyphFixture() -> [UInt8] {
        calibrationCorpus.first(where: { $0.name == "light-document" })?.luminance
            ?? Self.glyph(base: 245, ink: 25, indices: [10, 11, 18, 19, 26, 27])
    }

    func testCalibrationCorpusClassifiesBlankAndValuableScreenClasses() {
        for fixture in calibrationCorpus {
            let decision = evaluate(fixture.luminance)
            if fixture.shouldAdmit {
                guard case .accept = decision else {
                    XCTFail("Expected \(fixture.name) to be admitted, got \(decision).")
                    continue
                }
            } else {
                XCTAssertEqual(decision, .skip(.blank), fixture.name)
            }
        }
    }

    func testQuantizedNearDuplicateInSameWindowIsSkipped() throws {
        let initial = visibleGlyphFixture()
        let fingerprint = try acceptedFingerprint(evaluate(initial))

        var displayJitter = initial
        // 245 and 246 fall in the same 16-level quantization bucket. This is
        // display/compositor jitter, not a visible content change.
        displayJitter[17] = 246
        XCTAssertEqual(evaluate(displayJitter, previous: fingerprint), .skip(.duplicate))
    }

    func testWindowOrApplicationChangeAdmitsTheFirstFrame() throws {
        let frame = visibleGlyphFixture()
        let fingerprint = try acceptedFingerprint(evaluate(frame))

        XCTAssertNoThrow(
            try acceptedFingerprint(
                evaluate(
                    frame,
                    context: CaptureFrameContext(bundleId: "com.apple.Safari", windowId: 102),
                    previous: fingerprint
                )
            )
        )
        XCTAssertNoThrow(
            try acceptedFingerprint(
                evaluate(
                    frame,
                    context: CaptureFrameContext(bundleId: "com.apple.TextEdit", windowId: 101),
                    previous: fingerprint
                )
            )
        )
    }

    func testVisibleTextChangeIsNeverClassifiedAsDuplicateByCalibrationFixture() throws {
        let initial = visibleGlyphFixture()
        let fingerprint = try acceptedFingerprint(evaluate(initial))

        var textChanged = initial
        textChanged[28] = 25
        XCTAssertNoThrow(try acceptedFingerprint(evaluate(textChanged, previous: fingerprint)))
    }
}
