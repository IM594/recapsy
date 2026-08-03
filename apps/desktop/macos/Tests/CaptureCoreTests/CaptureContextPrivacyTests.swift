import CaptureCore
import Foundation
import XCTest

final class CaptureContextPrivacyTests: XCTestCase {
    private let application = CaptureApplicationPayload(
        name: "Safari",
        bundleId: "com.apple.Safari"
    )

    private func policy(
        defaultAction: CaptureSourcePolicyAction = .allow,
        rules: [CaptureSourcePolicyRule] = []
    ) -> CaptureSourcePolicy {
        CaptureSourcePolicy(
            version: "policy-1",
            paused: false,
            defaultAction: defaultAction,
            rules: rules
        )
    }

    private func rule(
        id: String,
        kind: String,
        pattern: String,
        action: CaptureSourcePolicyAction
    ) -> CaptureSourcePolicyRule {
        CaptureSourcePolicyRule(
            id: id,
            kind: kind,
            scope: "workspace_default",
            pattern: pattern,
            action: action,
            enabled: true
        )
    }

    private var source: CaptureSourceIdentity {
        CaptureSourceIdentity(
            applicationName: application.name,
            bundleId: application.bundleId
        )
    }

    func testSanitizesDirectAccessibilityValuesToTheWireSafeContextShape() throws {
        let context = try XCTUnwrap(CaptureSourceContext.make(
            application: application,
            document: "/Users/alice/Documents/Quarterly Plan.md",
            url: "HTTPS://Portal.Example.test:443/projects/recapsy",
            windowTitle: "  Quarterly Planning  "
        ))

        XCTAssertEqual(context.window?.title, "Quarterly Planning")
        XCTAssertEqual(context.website?.origin, "https://portal.example.test")
        XCTAssertEqual(context.website?.host, "portal.example.test")
        XCTAssertEqual(context.document?.name, "Quarterly Plan.md")

        let payload = context.payload(
            application: application,
            observedAt: "2026-07-20T00:00:00.000Z",
            policy: CapturePolicyPayload(version: "policy-1", decision: "allow")
        )
        XCTAssertEqual(payload.app, application)
        XCTAssertEqual(payload.window?.title, "Quarterly Planning")
        XCTAssertEqual(payload.website?.origin, "https://portal.example.test")
        XCTAssertEqual(payload.document?.name, "Quarterly Plan.md")
        XCTAssertEqual(payload.contextFingerprint, context.fingerprint)
    }

    func testUnsafeAccessibilityValuesAreOmittedInsteadOfBeingProjected() throws {
        let context = try XCTUnwrap(CaptureSourceContext.make(
            application: application,
            document: "/Users/alice/Documents/secret\u{0000}.md",
            url: "https://alice:password@private.example.test/path?token=secret",
            windowTitle: "/Users/alice/Documents/private.txt"
        ))

        XCTAssertNil(context.window)
        XCTAssertNil(context.website)
        XCTAssertNil(context.document)

        let payload = context.payload(
            application: application,
            observedAt: "2026-07-20T00:00:00.000Z",
            policy: CapturePolicyPayload(version: "policy-1", decision: "allow")
        )
        let data = try JSONEncoder().encode(payload)
        let json = String(decoding: data, as: UTF8.self)
        XCTAssertFalse(json.contains("/Users/alice"))
        XCTAssertFalse(json.contains("token=secret"))
        XCTAssertFalse(json.contains("password"))
        XCTAssertFalse(json.contains("secret"))
    }

    func testFingerprintUsesOnlyNormalizedStableContextFields() throws {
        let first = try XCTUnwrap(CaptureSourceContext.make(
            application: application,
            document: "/Users/alice/Documents/Plan.md",
            url: "HTTPS://PORTAL.EXAMPLE.TEST:443/a/path",
            windowTitle: " Planning "
        ))
        let second = try XCTUnwrap(CaptureSourceContext.make(
            application: application,
            document: "/Users/bob/Projects/Plan.md",
            url: "https://portal.example.test/another/path",
            windowTitle: "Planning"
        ))

        XCTAssertEqual(first.fingerprint, second.fingerprint)
        XCTAssertEqual(first.fingerprint.count, 71)
        XCTAssertTrue(first.fingerprint.hasPrefix("sha256:"))
    }

    func testFingerprintCreatesANewFrameHistoryBoundaryWithoutUsingWindowIds() throws {
        let first = try XCTUnwrap(CaptureSourceContext.make(
            application: application,
            document: nil,
            url: "https://portal.example.test/first",
            windowTitle: "Planning"
        ))
        let second = try XCTUnwrap(CaptureSourceContext.make(
            application: application,
            document: nil,
            url: "https://portal.example.test/second",
            windowTitle: "Architecture Review"
        ))

        let prior = CaptureFrameFingerprint(
            context: CaptureFrameContext(
                bundleId: application.bundleId,
                windowId: 42,
                contextFingerprint: first.fingerprint
            ),
            digest: "frame-digest"
        )
        let next = CaptureFrameFingerprint(
            context: CaptureFrameContext(
                bundleId: application.bundleId,
                windowId: 42,
                contextFingerprint: second.fingerprint
            ),
            digest: "frame-digest"
        )

        XCTAssertNotEqual(first.fingerprint, second.fingerprint)
        XCTAssertNotEqual(prior, next)
    }

    func testRedactionKeepsOnlyAppLevelContextInTheCaptureResult() throws {
        let sourceContext = try XCTUnwrap(CaptureSourceContext.make(
            application: application,
            document: "/Users/alice/Documents/Plan.md",
            url: "https://portal.example.test/projects",
            windowTitle: "Planning"
        ))
        let receipt = CaptureReceipt(
            workspaceId: "workspace-1",
            deviceId: "device-1",
            captureId: "cap-redacted-context",
            observedAt: "2026-07-20T00:00:00.000Z",
            capturedAt: "2026-07-20T00:00:00.100Z",
            policy: CapturePolicyIdentity(
                hash: "sha256:" + String(repeating: "a", count: 64),
                version: "policy-1"
            ),
            source: CaptureWindowIdentity(
                application: application,
                windowId: 42,
                ownerProcessId: 4242
            ),
            sourceContext: sourceContext,
            screenshot: CaptureScreenshotRecord(
                ref: "cap-redacted-context/screenshot.webp",
                hash: "sha256:" + String(repeating: "b", count: 64),
                mimeType: "image/webp",
                sizeBytes: 512
            ),
            frameQuality: CaptureFrameQuality(luminanceBucket: 8, marginal: false),
            decision: "redact_context"
        )

        let payload = receipt.payload
        XCTAssertEqual(payload.context.app, application)
        XCTAssertEqual(payload.context.policy.decision, "redact_context")
        XCTAssertNil(payload.context.window)
        XCTAssertNil(payload.context.website)
        XCTAssertNil(payload.context.document)
        XCTAssertNil(payload.context.contextFingerprint)

        let encoded = try JSONEncoder().encode(payload)
        let root = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        )
        let context = try XCTUnwrap(root["context"] as? [String: Any])
        XCTAssertEqual(Set(context.keys), ["app", "observedAt", "policy"])
        XCTAssertFalse(String(decoding: encoded, as: UTF8.self).contains("fingerprint"))
        XCTAssertFalse(String(decoding: encoded, as: UTF8.self).contains("portal.example.test"))
    }

    func testDomainRulesRunOnlyAfterAContextHasASafeNormalizedHost() throws {
        let sourceContext = try XCTUnwrap(CaptureSourceContext.make(
            application: application,
            document: nil,
            url: "https://PRIVATE.Example.test/projects",
            windowTitle: nil
        ))
        let policy = policy(rules: [
            rule(
                id: "browser-no-ocr",
                kind: "bundle_id",
                pattern: "com.apple.Safari",
                action: .blockOcr
            ),
            rule(
                id: "private-domain",
                kind: "domain",
                pattern: "PRIVATE.EXAMPLE.TEST",
                action: .redactContext
            ),
        ])

        XCTAssertEqual(
            CaptureSourcePolicyEvaluator.decide(policy: policy, source: source).action,
            .blockOcr
        )
        let resolved = CaptureSourcePolicyEvaluator.decide(
            policy: policy,
            source: source,
            context: sourceContext
        )
        XCTAssertEqual(resolved.action, .redactContext)
        XCTAssertEqual(resolved.matchedRuleIds, ["browser-no-ocr", "private-domain"])
    }

    func testMalformedDomainPatternAndMissingUrlDoNotBlockUnrelatedCapture() {
        let malformed = policy(rules: [
            rule(
                id: "not-a-host",
                kind: "domain",
                pattern: "https://private.example.test",
                action: .blockCapture
            ),
        ])
        let domainOnly = policy(rules: [
            rule(
                id: "private-domain",
                kind: "domain",
                pattern: "private.example.test",
                action: .blockCapture
            ),
        ])

        XCTAssertEqual(
            CaptureSourcePolicyEvaluator.decide(
                policy: malformed,
                source: source,
                context: CaptureSourceContext.make(
                    application: application,
                    document: nil,
                    url: "https://private.example.test/path",
                    windowTitle: nil
                )
            ).action,
            .allow
        )
        XCTAssertEqual(
            CaptureSourcePolicyEvaluator.decide(policy: domainOnly, source: source).action,
            .allow
        )
    }

    func testDomainFamilyMatchesTheParentHostAndDotBoundarySubdomainsOnly() throws {
        let familyPolicy = policy(rules: [
            rule(
                id: "github-family",
                kind: "domain_family",
                pattern: "github.com",
                action: .blockCapture
            ),
        ])

        let parent = try XCTUnwrap(CaptureSourceContext.make(
            application: application,
            document: nil,
            url: "https://github.com/settings",
            windowTitle: nil
        ))
        let child = try XCTUnwrap(CaptureSourceContext.make(
            application: application,
            document: nil,
            url: "https://gist.github.com/example",
            windowTitle: nil
        ))
        let lookalike = try XCTUnwrap(CaptureSourceContext.make(
            application: application,
            document: nil,
            url: "https://notgithub.com",
            windowTitle: nil
        ))

        XCTAssertEqual(
            CaptureSourcePolicyEvaluator.decide(
                policy: familyPolicy,
                source: source,
                context: parent
            ).action,
            .blockCapture
        )
        XCTAssertEqual(
            CaptureSourcePolicyEvaluator.decide(
                policy: familyPolicy,
                source: source,
                context: child
            ).action,
            .blockCapture
        )
        XCTAssertEqual(
            CaptureSourcePolicyEvaluator.decide(
                policy: familyPolicy,
                source: source,
                context: lookalike
            ).action,
            .allow
        )
    }

    func testAppDomainAndDomainFamilyBlocksHappenBeforePixelsAndUnblockedSourceResumes() throws {
        let chromeApplication = CaptureApplicationPayload(
            name: "Google Chrome",
            bundleId: "com.google.Chrome"
        )
        let chrome = CaptureSourceIdentity(
            applicationName: "Google Chrome",
            bundleId: "com.google.Chrome"
        )
        let privacyPolicy = policy(rules: [
            rule(
                id: "block-chatgpt-app",
                kind: "bundle_id",
                pattern: "com.example.ChatGPT",
                action: .blockCapture
            ),
            rule(
                id: "block-github-domain",
                kind: "domain",
                pattern: "github.com",
                action: .blockCapture
            ),
            rule(
                id: "block-openrouter-family",
                kind: "domain_family",
                pattern: "openrouter.ai",
                action: .blockCapture
            ),
        ])
        let blockedApp = CaptureSourceIdentity(
            applicationName: "ChatGPT",
            bundleId: "com.example.ChatGPT"
        )
        let github = try XCTUnwrap(CaptureSourceContext.make(
            application: chromeApplication,
            document: nil,
            url: "https://github.com/recapsy/issues",
            windowTitle: "Issues"
        ))
        let openRouterChild = try XCTUnwrap(CaptureSourceContext.make(
            application: chromeApplication,
            document: nil,
            url: "https://chat.openrouter.ai/playground",
            windowTitle: "Playground"
        ))
        let unblocked = try XCTUnwrap(CaptureSourceContext.make(
            application: chromeApplication,
            document: nil,
            url: "https://example.com/notes",
            windowTitle: "Notes"
        ))

        let appDecision = CaptureSourcePolicyEvaluator.decide(
            policy: privacyPolicy,
            source: blockedApp
        )
        XCTAssertEqual(appDecision.action, CaptureSourcePolicyAction.blockCapture)
        XCTAssertEqual(appDecision.matchedRuleIds, ["block-chatgpt-app"])

        let domainDecision = CaptureSourcePolicyEvaluator.decide(
            policy: privacyPolicy,
            source: chrome,
            context: github
        )
        XCTAssertEqual(domainDecision.action, CaptureSourcePolicyAction.blockCapture)
        XCTAssertEqual(domainDecision.matchedRuleIds, ["block-github-domain"])

        let familyDecision = CaptureSourcePolicyEvaluator.decide(
            policy: privacyPolicy,
            source: chrome,
            context: openRouterChild
        )
        XCTAssertEqual(familyDecision.action, CaptureSourcePolicyAction.blockCapture)
        XCTAssertEqual(familyDecision.matchedRuleIds, ["block-openrouter-family"])

        let restoredDecision = CaptureSourcePolicyEvaluator.decide(
            policy: privacyPolicy,
            source: chrome,
            context: unblocked
        )
        XCTAssertEqual(restoredDecision.action, CaptureSourcePolicyAction.allow)
        XCTAssertEqual(restoredDecision.matchedRuleIds, [String]())
    }
}
