import { describe, expect, it } from 'bun:test';
import { urlPrivacyBehaviorCases } from './fixtures/url-privacy-behavior.fixture';
import { matchingMainBranchUrlRule } from './support/url-privacy-behavior-reference';

describe('main-branch URL privacy behavior reference', () => {
  for (const fixture of urlPrivacyBehaviorCases) {
    it(fixture.name, () => {
      expect(matchingMainBranchUrlRule(fixture.url, fixture.rules)).toBe(fixture.expectedRule);
    });
  }
});
