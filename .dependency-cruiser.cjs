/** @type {import('dependency-cruiser').IConfiguration} */

const TEST_SOURCE_PATH =
  '(?:^|/)(?:__tests__|test|tests)/|[.](?:test|spec)[.](?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$';

const SERVER_SOURCE_ROOT = 'apps/server/src';
const SERVER_CAPABILITIES = [
  'ai',
  'audit',
  'capture',
  'identity',
  'ocr-proxy',
  'provider-settings',
  'registration',
  'search',
  'subscriptions',
  'timeline',
];

const DESKTOP_SOURCE_ROOT = 'apps/desktop/src';
const DESKTOP_CAPABILITIES = [
  'auth',
  'capture',
  'helper',
  'ipc',
  'server',
  'status',
  'storage',
  'sync',
];

function publicSurfaceRules(rulePrefix, sourceRoot, capabilities, exceptions = {}) {
  return capabilities.map((targetCapability) => {
    const exceptionSurfaces = exceptions[targetCapability] ?? [];
    const allowedSurfaces = ['public', ...exceptionSurfaces]
      .map((surface) => `${surface}[.]ts`)
      .join('|');

    return {
      name: `${rulePrefix}-${targetCapability}-only-public-surface`,
      severity: 'error',
      comment:
        'All production code outside a capability must depend on it through its public.ts surface.',
      from: {
        path: `^${sourceRoot}/`,
        pathNot: `(?:${TEST_SOURCE_PATH}|^${sourceRoot}/${targetCapability}/)`,
      },
      to: {
        path: `^${sourceRoot}/${targetCapability}/`,
        pathNot: `^${sourceRoot}/${targetCapability}/(?:${allowedSurfaces})$`,
      },
    };
  });
}

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Circular dependencies make capability ownership and initialization order ambiguous.',
      from: {},
      to: {
        circular: true,
      },
    },
    ...publicSurfaceRules('server', SERVER_SOURCE_ROOT, SERVER_CAPABILITIES),
    {
      name: 'server-ai-not-to-database',
      severity: 'error',
      comment: 'AI runtime must not depend on Drizzle schema or other shared database details.',
      from: {
        path: `^${SERVER_SOURCE_ROOT}/ai/`,
        pathNot: TEST_SOURCE_PATH,
      },
      to: {
        path: `^${SERVER_SOURCE_ROOT}/shared/db(?:/|[.])`,
      },
    },
    {
      name: 'server-ai-not-to-account-capabilities',
      severity: 'error',
      comment:
        'AI runtime consumes provider credentials through the provider-settings resolver port.',
      from: {
        path: `^${SERVER_SOURCE_ROOT}/ai/`,
        pathNot: TEST_SOURCE_PATH,
      },
      to: {
        path: `^${SERVER_SOURCE_ROOT}/(?:audit|identity|registration|subscriptions)/`,
      },
    },
    {
      name: 'server-provider-settings-not-to-account-capabilities',
      severity: 'error',
      comment:
        'Provider settings owns provider records, scope resolution, and secret materialization.',
      from: {
        path: `^${SERVER_SOURCE_ROOT}/provider-settings/`,
        pathNot: TEST_SOURCE_PATH,
      },
      to: {
        path: `^${SERVER_SOURCE_ROOT}/(?:audit|identity|registration|subscriptions)/`,
      },
    },
    ...publicSurfaceRules('desktop', DESKTOP_SOURCE_ROOT, DESKTOP_CAPABILITIES, {
      storage: ['node'],
    }),
    {
      name: 'desktop-storage-node-only-from-electron-root',
      severity: 'error',
      comment:
        'Only the Electron composition root may instantiate the Node SQLite persistence adapter.',
      from: {
        path: `^${DESKTOP_SOURCE_ROOT}/`,
        pathNot: `(?:${TEST_SOURCE_PATH}|^${DESKTOP_SOURCE_ROOT}/main/electron-entry[.]ts$)`,
      },
      to: {
        path: `^${DESKTOP_SOURCE_ROOT}/storage/node[.]ts$`,
      },
    },
  ],
  options: {
    combinedDependencies: true,
    doNotFollow: {
      path: 'node_modules',
    },
    tsPreCompilationDeps: true,
  },
};
