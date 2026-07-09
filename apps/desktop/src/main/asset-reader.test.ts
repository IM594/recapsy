import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createLocalAssetReader,
  isResolvedPathWithinRoot,
  resolveCaptureAssetPath,
} from './asset-reader';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function makeAssetRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'recapsy-asset-root-'));
  tempDirs.push(root);
  return root;
}

/** Mirrors the sync scheduler's `isSafeErrorShape` / `isLocalAssetSafeCode`. */
function expectUnreadable(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  const shaped = error as { code?: unknown; retryable?: unknown; safeMessage?: unknown };
  expect(shaped.code).toBe('local_asset_unreadable');
  expect(shaped.retryable).toBe(false);
  expect(shaped.safeMessage).toBe('Local asset is unreadable.');
}

/** Captures whatever `resolveCaptureAssetPath` throws for a key (pure, no IO). */
function catchResolve(assetRoot: string, localAccessKey: string): unknown {
  try {
    resolveCaptureAssetPath(assetRoot, localAccessKey);
    return undefined;
  } catch (error) {
    return error;
  }
}

/** No field of the thrown error may leak the absolute path being read. */
function expectNoPathLeak(error: unknown, ...paths: string[]): void {
  const shaped = error as { message?: unknown; safeMessage?: unknown };
  for (const leaked of [shaped.message, shaped.safeMessage]) {
    expect(typeof leaked).toBe('string');
    for (const secret of paths) {
      expect(leaked as string).not.toContain(secret);
    }
  }
}

describe('createLocalAssetReader', () => {
  it('reads the real bytes of a file at a relative access key', async () => {
    const root = makeAssetRoot();
    const captureId = 'cap_1';
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    mkdirSync(path.join(root, captureId), { recursive: true });
    writeFileSync(path.join(root, captureId, 'screenshot.jpg'), bytes);

    const read = createLocalAssetReader({ assetRoot: root });
    const result = await read(`${captureId}/screenshot.jpg`);

    expect(Uint8Array.from(result)).toEqual(bytes);
  });

  it('rejects a `..` traversal key with the fail-closed shape and no path leak', async () => {
    const parent = makeAssetRoot();
    const root = path.join(parent, 'captures');
    mkdirSync(root, { recursive: true });
    // A real secret file just outside the root, to prove it is never read.
    writeFileSync(path.join(parent, 'secret.jpg'), new Uint8Array([1, 2, 3]));

    const read = createLocalAssetReader({ assetRoot: root });

    let thrown: unknown;
    try {
      await read('../secret.jpg');
    } catch (error) {
      thrown = error;
    }

    expectUnreadable(thrown);
    expectNoPathLeak(thrown, parent, root);
  });

  it('rejects an absolute-path key', async () => {
    const root = makeAssetRoot();
    const read = createLocalAssetReader({ assetRoot: root });

    let thrown: unknown;
    try {
      await read('/etc/passwd');
    } catch (error) {
      thrown = error;
    }

    expectUnreadable(thrown);
    expectNoPathLeak(thrown, '/etc/passwd', root);
  });

  it('rejects a `file://` key', async () => {
    const root = makeAssetRoot();
    const read = createLocalAssetReader({ assetRoot: root });

    let thrown: unknown;
    try {
      await read('file:///etc/passwd');
    } catch (error) {
      thrown = error;
    }

    expectUnreadable(thrown);
    expectNoPathLeak(thrown, '/etc/passwd', root);
  });

  it('fails closed when the file does not exist', async () => {
    const root = makeAssetRoot();
    const read = createLocalAssetReader({ assetRoot: root });

    let thrown: unknown;
    try {
      await read('cap_missing/screenshot.jpg');
    } catch (error) {
      thrown = error;
    }

    expectUnreadable(thrown);
    expectNoPathLeak(thrown, root);
  });

  it('folds an EISDIR (key points at a directory) into the fail-closed shape', async () => {
    const root = makeAssetRoot();
    // A real directory inside the root so the resolved path is contained but
    // `readFile` still throws EISDIR — must collapse to `local_asset_unreadable`.
    mkdirSync(path.join(root, 'cap_dir'), { recursive: true });
    const read = createLocalAssetReader({ assetRoot: root });

    let thrown: unknown;
    try {
      await read('cap_dir');
    } catch (error) {
      thrown = error;
    }

    expectUnreadable(thrown);
    expectNoPathLeak(thrown, root);
  });
});

describe('resolveCaptureAssetPath key rejection', () => {
  it('rejects Windows drive-letter keys (both slash styles)', () => {
    const backslash = catchResolve('/x/root', 'C:\\x.jpg');
    const forwardslash = catchResolve('/x/root', 'C:/x.jpg');

    expectUnreadable(backslash);
    expectNoPathLeak(backslash, '/x/root');
    expectUnreadable(forwardslash);
    expectNoPathLeak(forwardslash, '/x/root');
  });

  it('rejects a backslash `..` traversal key', () => {
    const thrown = catchResolve('/x/root', '..\\secret.jpg');

    expectUnreadable(thrown);
    expectNoPathLeak(thrown, '/x/root');
  });

  it('rejects an empty key', () => {
    const thrown = catchResolve('/x/root', '');

    expectUnreadable(thrown);
  });

  it('rejects a single-dot key that resolves to the root itself', () => {
    const thrown = catchResolve('/x/root', '.');

    expectUnreadable(thrown);
  });
});

describe('resolveCaptureAssetPath prefix trap', () => {
  it('does not treat a sibling directory sharing a name prefix as inside the root', () => {
    // `/x/root` vs `/x/root-evil`: the containment check must use the path
    // separator so the sibling is refused.
    expect(isResolvedPathWithinRoot('/x/root', '/x/root-evil/secret.jpg')).toBe(false);
    expect(isResolvedPathWithinRoot('/x/root', '/x/root/cap_1/screenshot.jpg')).toBe(true);
    // The root itself is NOT "within" — `isResolvedPathWithinRoot` owns the
    // reject-the-root decision (S1), so a valid key must name a file beneath it.
    expect(isResolvedPathWithinRoot('/x/root', '/x/root')).toBe(false);
  });

  it('rejects a key that escapes into a prefix-sibling directory of the root', () => {
    const base = makeAssetRoot();
    const root = path.join(base, 'root');
    mkdirSync(root, { recursive: true });
    // Sibling `<base>/root-evil` shares the `root` name prefix.
    const evilDir = path.join(base, 'root-evil');
    mkdirSync(evilDir, { recursive: true });
    writeFileSync(path.join(evilDir, 'secret.jpg'), new Uint8Array([9, 9, 9]));

    let thrown: unknown;
    try {
      resolveCaptureAssetPath(root, '../root-evil/secret.jpg');
    } catch (error) {
      thrown = error;
    }

    expectUnreadable(thrown);
    expectNoPathLeak(thrown, base, root, evilDir);
  });
});
