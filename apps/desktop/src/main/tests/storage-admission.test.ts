import { afterEach, describe, expect, it } from 'bun:test';
import { constants, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createLocalStorageAdmissionProbe,
  createLocalStorageWriteVerifier,
} from '../storage-admission';

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('local storage admission probe', () => {
  it('uses the production Node filesystem bindings against the real capture volume', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'recapsy-storage-admission-'));
    const assetRoot = path.join(directory, 'captures');
    tempDirs.push(directory);

    const probe = createLocalStorageAdmissionProbe({ assetRoot });
    const verifyWrite = createLocalStorageWriteVerifier({ assetRoot });

    await expect(probe()).resolves.toMatchObject({ writable: true });
    expect((await probe()).availableBytes).toBeGreaterThan(0);
    await expect(verifyWrite()).resolves.toBeUndefined();
    expect(readdirSync(assetRoot)).toEqual([]);
  });

  it('reports real filesystem available bytes and verifies write access without creating or deleting files', async () => {
    const accessCalls: Array<{ mode: number; path: string }> = [];
    const statfsCalls: string[] = [];
    const probe = createLocalStorageAdmissionProbe({
      assetRoot: '/volume/captures',
      fileSystem: {
        async access(path, mode) {
          accessCalls.push({ mode, path });
        },
        async statfs(path) {
          statfsCalls.push(path);
          return { bavail: 1000, bsize: 4096 };
        },
      },
    });

    await expect(probe()).resolves.toEqual({
      availableBytes: 4_096_000,
      writable: true,
    });
    expect(statfsCalls).toEqual(['/volume/captures']);
    expect(accessCalls).toEqual([
      { mode: constants.W_OK | constants.X_OK, path: '/volume/captures' },
    ]);
  });

  it('uses the nearest existing parent when the capture directory has not been created yet', async () => {
    const probe = createLocalStorageAdmissionProbe({
      assetRoot: '/volume/user/captures',
      fileSystem: {
        async access() {},
        async statfs(path) {
          if (path === '/volume/user/captures') {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          }
          return { bavail: 20, bsize: 512 };
        },
      },
    });

    await expect(probe()).resolves.toEqual({ availableBytes: 10_240, writable: true });
  });

  it('reports a non-writable volume as a storage signal instead of hiding it as probe failure', async () => {
    const probe = createLocalStorageAdmissionProbe({
      assetRoot: '/volume/captures',
      fileSystem: {
        async access() {
          throw Object.assign(new Error('read only'), { code: 'EACCES' });
        },
        async statfs() {
          return { bavail: 1000, bsize: 4096 };
        },
      },
    });

    await expect(probe()).resolves.toEqual({
      availableBytes: 4_096_000,
      writable: false,
    });
  });

  it('verifies recovery with a real write, fsync, close, and cleanup of only its own probe', async () => {
    const calls: string[] = [];
    let unlinkCalls = 0;
    const verifyWrite = createLocalStorageWriteVerifier({
      assetRoot: '/volume/captures',
      fileSystem: {
        async mkdir(path) {
          calls.push(`mkdir:${path}`);
        },
        async open(path) {
          calls.push(`open:${path}`);
          return {
            async close() {
              calls.push('close');
            },
            async sync() {
              calls.push('sync');
            },
            async writeFile(bytes) {
              calls.push(`write:${bytes.byteLength}`);
            },
          };
        },
        async unlink(path) {
          calls.push(`unlink:${path}`);
          unlinkCalls += 1;
          if (unlinkCalls === 1) {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          }
        },
      },
    });

    await verifyWrite();

    expect(calls).toEqual([
      'mkdir:/volume/captures',
      'unlink:/volume/captures/.recapsy-admission-write-probe',
      'open:/volume/captures/.recapsy-admission-write-probe',
      'write:1',
      'sync',
      'close',
      'unlink:/volume/captures/.recapsy-admission-write-probe',
    ]);
  });

  it('removes a stale fixed self-owned probe before opening a new exclusive probe', async () => {
    const calls: string[] = [];
    const verifyWrite = createLocalStorageWriteVerifier({
      assetRoot: '/volume/captures',
      fileSystem: {
        async mkdir() {},
        async open(path) {
          calls.push(`open:${path}`);
          return {
            async close() {},
            async sync() {},
            async writeFile() {},
          };
        },
        async unlink(path) {
          calls.push(`unlink:${path}`);
        },
      },
    });

    await verifyWrite();

    expect(calls).toEqual([
      'unlink:/volume/captures/.recapsy-admission-write-probe',
      'open:/volume/captures/.recapsy-admission-write-probe',
      'unlink:/volume/captures/.recapsy-admission-write-probe',
    ]);
  });

  it('fails closed before open when stale-probe cleanup fails with a non-ENOENT error', async () => {
    let openCalls = 0;
    const verifyWrite = createLocalStorageWriteVerifier({
      assetRoot: '/volume/captures',
      fileSystem: {
        async mkdir() {},
        async open() {
          openCalls += 1;
          throw new Error('must not open');
        },
        async unlink() {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        },
      },
    });

    await expect(verifyWrite()).rejects.toThrow('storage_write_verification_failed');
    expect(openCalls).toBe(0);
  });

  it('still cleans up its own probe when fsync fails', async () => {
    const calls: string[] = [];
    let unlinkCalls = 0;
    const verifyWrite = createLocalStorageWriteVerifier({
      assetRoot: '/volume/captures',
      fileSystem: {
        async mkdir() {},
        async open() {
          return {
            async close() {
              calls.push('close');
            },
            async sync() {
              throw new Error('fsync failed');
            },
            async writeFile() {},
          };
        },
        async unlink() {
          unlinkCalls += 1;
          if (unlinkCalls === 1) {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          }
          calls.push('unlink');
        },
      },
    });

    await expect(verifyWrite()).rejects.toThrow('storage_write_verification_failed');
    expect(calls).toEqual(['close', 'unlink']);
  });
});
