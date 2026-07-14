/** @type {import('dependency-cruiser').IConfiguration} */

const TEST_SOURCE_PATH =
  '(?:^|/)(?:__tests__|test|tests)/|[.](?:test|spec)[.](?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$';

const SERVER_SOURCE_ROOT = 'apps/server/src';
const SERVER_CAPABILITIES = [
  'account-management',
  'ai-runtime',
  'capture-ocr-search',
  'ocr-proxy',
  'provider-settings',
];

const DESKTOP_SOURCE_ROOT = 'apps/desktop/src';
const DESKTOP_CAPABILITIES = ['auth', 'helper', 'ipc', 'runtime', 'server-api', 'storage', 'sync'];

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
    ...publicSurfaceRules('server', SERVER_SOURCE_ROOT, SERVER_CAPABILITIES, {
      'account-management': ['composition'],
    }),
    {
      name: 'server-account-management-composition-only-from-roots',
      severity: 'error',
      comment:
        'Only the server composition roots may instantiate the account-management persistence adapter.',
      from: {
        path: `^${SERVER_SOURCE_ROOT}/`,
        pathNot: `(?:${TEST_SOURCE_PATH}|^${SERVER_SOURCE_ROOT}/(?:app|index)[.]ts$)`,
      },
      to: {
        path: `^${SERVER_SOURCE_ROOT}/account-management/composition[.]ts$`,
      },
    },
    {
      name: 'server-ai-runtime-not-to-database',
      severity: 'error',
      comment: 'AI runtime must not depend on Drizzle schema or other shared database details.',
      from: {
        path: `^${SERVER_SOURCE_ROOT}/ai-runtime/`,
        pathNot: TEST_SOURCE_PATH,
      },
      to: {
        path: `^${SERVER_SOURCE_ROOT}/shared/db(?:/|[.])`,
      },
    },
    ...publicSurfaceRules('desktop', DESKTOP_SOURCE_ROOT, DESKTOP_CAPABILITIES, {
      storage: ['composition'],
    }),
    {
      name: 'desktop-storage-composition-only-from-electron-root',
      severity: 'error',
      comment:
        'Only the Electron composition root may instantiate the Node SQLite persistence adapter.',
      from: {
        path: `^${DESKTOP_SOURCE_ROOT}/`,
        pathNot: `(?:${TEST_SOURCE_PATH}|^${DESKTOP_SOURCE_ROOT}/main/electron-entry[.]ts$)`,
      },
      to: {
        path: `^${DESKTOP_SOURCE_ROOT}/storage/composition[.]ts$`,
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
