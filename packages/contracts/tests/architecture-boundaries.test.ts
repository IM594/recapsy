import { describe, expect, test } from 'bun:test';
import path from 'node:path';

describe('contracts architecture boundaries', () => {
  test('keeps TypeScript tests in approved directories and out of production imports', async () => {
    const packageRoot = path.resolve(import.meta.dir, '..');
    const glob = new Bun.Glob('**/*.ts');
    const violations: string[] = [];

    for (const sourceRoot of ['src', 'tests']) {
      for await (const relativePath of glob.scan({ cwd: path.join(packageRoot, sourceRoot) })) {
        const packageRelativePath = `${sourceRoot}/${relativePath}`;
        const isTestFile = relativePath.endsWith('.test.ts');
        const isSpecFile = relativePath.endsWith('.spec.ts');
        const isApprovedTestLocation =
          /^src\/[^/]+\/tests\/(?:.+\/)?[^/]+\.test\.ts$/.test(packageRelativePath) ||
          /^tests\/(?:.+\/)?[^/]+\.test\.ts$/.test(packageRelativePath);

        if (packageRelativePath.includes('/__tests__/')) {
          violations.push(`uses a forbidden __tests__ directory: ${packageRelativePath}`);
        }
        if (isSpecFile) {
          violations.push(`uses a forbidden .spec.ts test suffix: ${packageRelativePath}`);
        }
        if (isTestFile && !isApprovedTestLocation) {
          violations.push(
            `keeps a TypeScript test outside an approved tests directory: ${packageRelativePath}`,
          );
        }
        if (isTestFile || isSpecFile || sourceRoot !== 'src') continue;

        const source = await Bun.file(path.join(packageRoot, packageRelativePath)).text();
        const importPattern = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
        for (const match of source.matchAll(importPattern)) {
          const specifier = match[1]?.replaceAll('\\', '/');
          if (!specifier) continue;
          if (
            /(^|\/)tests(?:\/|$)/.test(specifier) ||
            /\.(?:test|spec)(?:\.[cm]?[jt]s)?$/.test(specifier)
          ) {
            violations.push(
              `production source imports tests: ${packageRelativePath} -> ${specifier}`,
            );
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
