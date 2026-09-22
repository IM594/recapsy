/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'mcp-no-ingest-enrich',
      comment:
        'mcp never imports core/ingest or core/enrich (architecture.md § Dependency direction)',
      severity: 'error',
      from: { path: '^mcp/' },
      to: { path: '^core/(ingest|enrich)/' },
    },
    {
      name: 'core-no-electron',
      comment: 'No package under core/ may import Electron (architecture.md § Directory layout)',
      severity: 'error',
      from: { path: '^core/' },
      to: { path: '^electron$|(^|/)node_modules/electron/' },
    },
    {
      name: 'memory-no-workspace-deps',
      comment: 'core/memory has no internal dependencies (architecture.md § Dependency direction)',
      severity: 'error',
      from: { path: '^core/memory/' },
      to: { path: '^(core/(ingest|enrich)|app/|mcp/)' },
    },
    {
      name: 'web-only-memory',
      comment:
        'app/web may import from core/memory only among workspace packages (architecture.md § Dependency direction)',
      severity: 'error',
      from: { path: '^app/web/' },
      to: { path: '^(core/(ingest|enrich)|mcp/)' },
    },
    {
      name: 'no-test-imports-in-production',
      comment: 'Production code never imports from a test directory (AGENTS.md § Tests)',
      severity: 'error',
      from: { pathNot: '/tests/' },
      to: { path: '/tests/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules|dist' },
    exclude: { path: 'node_modules|dist' },
  },
};
