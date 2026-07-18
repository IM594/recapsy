import CaptureCore
import Foundation
import XCTest

final class CapturePolicyCanonicalTests: XCTestCase {
    private struct Fixture: Decodable {
        struct Input: Decodable {
            let defaultAction: String
            let localRules: [Rule]
            let paused: Bool
            let version: String
            let workspaceRules: [Rule]
        }

        struct Expected: Decodable {
            let canonicalJson: String
            let orderedRuleIds: [String]
            let policyHash: String
        }

        struct Rule: Decodable {
            let action: String
            let enabled: Bool
            let id: String
            let kind: String
            let pattern: String
            let scope: String

            var canonical: CapturePolicyCanonicalRule {
                CapturePolicyCanonicalRule(
                    action: action,
                    enabled: enabled,
                    id: id,
                    kind: kind,
                    pattern: pattern,
                    scope: scope
                )
            }
        }

        let input: Input
        let expected: Expected
    }

    func testMatchesSharedUTF8CanonicalPolicyFixture() throws {
        let fixtureURL = try XCTUnwrap(Bundle.module.url(
            forResource: "policy-canonical",
            withExtension: "json"
        ))
        let fixture = try JSONDecoder().decode(
            Fixture.self,
            from: Data(contentsOf: fixtureURL)
        )
        let hardRules = [
            CapturePolicyCanonicalRule(
                action: "block_capture",
                enabled: true,
                id: "hard:recapsy-capture",
                kind: "bundle_id",
                pattern: "one.recapsy.desktop.capture",
                scope: "hard"
            ),
            CapturePolicyCanonicalRule(
                action: "block_capture",
                enabled: true,
                id: "hard:recapsy-desktop",
                kind: "bundle_id",
                pattern: "one.recapsy.desktop",
                scope: "hard"
            ),
        ]
        let snapshot = CapturePolicyCanonicalSnapshot(
            defaultAction: fixture.input.defaultAction,
            paused: fixture.input.paused,
            rules: fixture.input.workspaceRules.map(\.canonical)
                + fixture.input.localRules.map(\.canonical)
                + hardRules,
            version: fixture.input.version
        )

        XCTAssertEqual(snapshot.rules.map(\.id), fixture.expected.orderedRuleIds)
        XCTAssertEqual(try snapshot.canonicalJSON(), fixture.expected.canonicalJson)
        XCTAssertEqual(try snapshot.policyHash(), fixture.expected.policyHash)
    }

    func testRejectsNULUsedAsTheCanonicalSortSeparator() {
        XCTAssertTrue(CapturePolicyCanonicalRule.isSupportedText("com.example.safe"))
        XCTAssertFalse(CapturePolicyCanonicalRule.isSupportedText("com.example\0unsafe"))
    }
}
