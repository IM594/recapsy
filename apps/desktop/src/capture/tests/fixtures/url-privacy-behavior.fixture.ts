export type UrlPrivacyBehaviorCase = {
  expectedRule: string | null;
  name: string;
  rules: readonly string[];
  url: string | null;
};

export const urlPrivacyBehaviorCases: readonly UrlPrivacyBehaviorCase[] = [
  {
    expectedRule: 'docs.example.test',
    name: 'current host matches itself',
    rules: ['docs.example.test'],
    url: 'https://docs.example.test',
  },
  {
    expectedRule: 'docs.example.test',
    name: 'current host also matches a dot-boundary subdomain',
    rules: ['docs.example.test'],
    url: 'https://preview.docs.example.test/project',
  },
  {
    expectedRule: null,
    name: 'host suffix without a dot boundary does not match',
    rules: ['docs.example.test'],
    url: 'https://notdocs.example.test',
  },
  {
    expectedRule: 'example.test',
    name: 'parent-domain target matches the parent host',
    rules: ['example.test'],
    url: 'https://example.test',
  },
  {
    expectedRule: 'example.test',
    name: 'parent-domain target matches every deeper subdomain',
    rules: ['example.test'],
    url: 'https://deep.docs.example.test',
  },
  {
    expectedRule: 'example.test/private',
    name: 'path target matches the parent host and a path prefix',
    rules: ['example.test/private'],
    url: 'https://example.test/private/project',
  },
  {
    expectedRule: 'example.test/private',
    name: 'path target also matches subdomains',
    rules: ['example.test/private'],
    url: 'https://docs.example.test/private',
  },
  {
    expectedRule: 'example.test/private',
    name: 'path prefix is textual rather than segment-aware',
    rules: ['example.test/private'],
    url: 'https://docs.example.test/private-notes',
  },
  {
    expectedRule: null,
    name: 'path target rejects a different path',
    rules: ['example.test/private'],
    url: 'https://docs.example.test/public',
  },
  {
    expectedRule: 'EXAMPLE.TEST/PRIVATE',
    name: 'host, path, and rule comparisons ignore ASCII case',
    rules: ['EXAMPLE.TEST/PRIVATE'],
    url: 'https://DOCS.EXAMPLE.TEST/Private/Project',
  },
  {
    expectedRule: 'example.test/private',
    name: 'port does not participate in matching',
    rules: ['example.test/private'],
    url: 'https://docs.example.test:8443/private',
  },
  {
    expectedRule: 'example.test/private',
    name: 'query does not participate in a positive match',
    rules: ['example.test/private'],
    url: 'https://docs.example.test/private?view=public',
  },
  {
    expectedRule: null,
    name: 'query cannot turn a different path into a match',
    rules: ['example.test/private'],
    url: 'https://docs.example.test/public?next=/private',
  },
  {
    expectedRule: null,
    name: 'fragment cannot turn a different path into a match',
    rules: ['example.test/private'],
    url: 'https://docs.example.test/public#/private',
  },
  {
    expectedRule: 'example.test/private/',
    name: 'trailing slash in a rule matches the same slash in the URL',
    rules: ['example.test/private/'],
    url: 'https://docs.example.test/private/item',
  },
  {
    expectedRule: null,
    name: 'trailing slash in a rule remains significant',
    rules: ['example.test/private/'],
    url: 'https://docs.example.test/private',
  },
  {
    expectedRule: 'example.test/private',
    name: 'a schemeless URL is interpreted as HTTPS',
    rules: ['example.test/private'],
    url: 'docs.example.test/private',
  },
  {
    expectedRule: null,
    name: 'missing URL does not match',
    rules: ['example.test'],
    url: null,
  },
  {
    expectedRule: null,
    name: 'empty URL does not match',
    rules: ['example.test'],
    url: '',
  },
  {
    expectedRule: null,
    name: 'URL parse failure does not match',
    rules: ['example.test'],
    url: 'https://',
  },
];
