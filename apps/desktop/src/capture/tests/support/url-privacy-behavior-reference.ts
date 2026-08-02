/**
 * Test-only behavior reference extracted from the legacy main branch.
 * This is not a runtime policy entry point; T1.2/T1.3 must design their own
 * contract and native enforcement after the product-facing targets are approved.
 */
export function matchingMainBranchUrlRule(
  url: string | null,
  blockedRules: readonly string[],
): string | null {
  if (url === null || url.length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
  } catch {
    return null;
  }
  if (parsed.hostname.length === 0) return null;

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();

  for (const blockedRule of blockedRules) {
    const normalizedRule = blockedRule.toLowerCase();
    const slashIndex = normalizedRule.indexOf('/');
    if (slashIndex === -1) {
      if (matchesHost(host, normalizedRule)) return blockedRule;
      continue;
    }

    const blockedHost = normalizedRule.slice(0, slashIndex);
    const blockedPath = normalizedRule.slice(slashIndex);
    if (matchesHost(host, blockedHost) && path.startsWith(blockedPath)) {
      return blockedRule;
    }
  }

  return null;
}

function matchesHost(host: string, blockedHost: string): boolean {
  return host === blockedHost || host.endsWith(`.${blockedHost}`);
}
