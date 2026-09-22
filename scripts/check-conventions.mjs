import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const SKIP_ENTRIES = new Set(['node_modules', 'dist', '.gitkeep']);
const SKIP_PACKAGES = new Set(['app/capture']);
const TOP_DIRS = ['app', 'core', 'mcp'];
const BANNED_WORDS = new Set(['tmp', 'stub', 'foundation', 'slice', 'v0', 'next']);

const violations = [];

function splitCamelCase(name) {
  return name.replace(/([a-z])([A-Z])/g, '$1\0$2').split('\0');
}

function extractWords(name) {
  const words = [];
  for (const segment of name.split(/[-_.]/)) {
    for (const word of splitCamelCase(segment)) {
      if (word) words.push(word.toLowerCase());
    }
  }
  return words;
}

function checkBannedWords(relPath, name) {
  for (const word of extractWords(name)) {
    if (BANNED_WORDS.has(word)) {
      violations.push(`${relPath}: basename contains banned word "${word}"`);
    }
  }
}

function packageRootDepth(parts) {
  if ((parts[0] === 'app' || parts[0] === 'core') && parts.length >= 2) return 2;
  if (parts[0] === 'mcp') return 1;
  return null;
}

function checkTestFilePlacement(relPath) {
  if (!relPath.endsWith('.test.ts')) return;

  const parts = relPath.split('/');
  const depth = packageRootDepth(parts);
  if (depth === null) {
    violations.push(`${relPath}: test file outside a recognized package`);
    return;
  }

  const rel = parts.slice(depth);
  const validSrcModule = rel.length === 4 && rel[0] === 'src' && rel[2] === 'tests';
  const validIntegration = rel.length === 3 && rel[0] === 'tests' && rel[1] === 'integration';

  if (!validSrcModule && !validIntegration) {
    violations.push(
      `${relPath}: test file not in <package>/src/<module>/tests/ or <package>/tests/integration/`,
    );
  }
}

async function walkDir(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const name = entry.name;
    if (SKIP_ENTRIES.has(name)) continue;

    const fullPath = join(dir, name);
    const relPath = relative('.', fullPath);

    if (entry.isDirectory()) {
      if (SKIP_PACKAGES.has(relPath)) continue;
      if (name === '__tests__') {
        violations.push(`${relPath}: __tests__ directories are not allowed`);
      }
      checkBannedWords(relPath, name);
      await walkDir(fullPath);
    } else if (entry.isFile()) {
      checkBannedWords(relPath, name);
      if (relPath.endsWith('.spec.ts')) {
        violations.push(`${relPath}: .spec.ts files are not allowed, use .test.ts`);
      }
      checkTestFilePlacement(relPath);
    }
  }
}

async function findPackageJsonFiles(dir) {
  const files = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findPackageJsonFiles(fullPath)));
    } else if (entry.name === 'package.json') {
      files.push(fullPath);
    }
  }
  return files;
}

async function checkPinnedVersions() {
  const packageFiles = await findPackageJsonFiles('.');
  for (const file of packageFiles) {
    const relPath = relative('.', file);
    const content = JSON.parse(await readFile(file, 'utf-8'));
    for (const section of ['dependencies', 'devDependencies']) {
      const deps = content[section];
      if (!deps) continue;
      for (const [name, version] of Object.entries(deps)) {
        if (typeof version === 'string' && (version.startsWith('^') || version.startsWith('~'))) {
          violations.push(
            `${relPath}: ${section}.${name} version "${version}" is not exact-pinned`,
          );
        }
      }
    }
  }
}

async function main() {
  for (const dir of TOP_DIRS) {
    await walkDir(dir);
  }
  await checkPinnedVersions();

  if (violations.length > 0) {
    for (const v of violations) {
      console.error(v);
    }
    console.error(`\n${violations.length} convention violation(s) found.`);
    process.exit(1);
  } else {
    console.log('All convention checks passed.');
  }
}

main();
