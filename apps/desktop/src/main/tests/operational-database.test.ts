import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import {
  migrateLegacyOperationalDatabase,
  prepareOperationalDatabase,
  resolveOperationalDatabasePath,
} from '../operational-database';

const DIRECTORY = '/Users/example/Library/Application Support/one.recapsy.desktop';

describe('operational database identity', () => {
  it('uses the product-owned database filename', () => {
    expect(resolveOperationalDatabasePath(DIRECTORY)).toBe(
      path.join(DIRECTORY, 'operational.sqlite3'),
    );
  });

  it('migrates the legacy database and its WAL/SHM sidecars', () => {
    const existing = new Set([
      path.join(DIRECTORY, 'recapsy-desktop-dev.sqlite3'),
      path.join(DIRECTORY, 'recapsy-desktop-dev.sqlite3-wal'),
      path.join(DIRECTORY, 'recapsy-desktop-dev.sqlite3-shm'),
    ]);
    const moves: string[] = [];

    expect(
      migrateLegacyOperationalDatabase(DIRECTORY, {
        exists(filePath) {
          return existing.has(filePath);
        },
        rename(from, to) {
          moves.push(`${path.basename(from)}->${path.basename(to)}`);
        },
      }),
    ).toBe('migrated');
    expect(moves).toEqual([
      'recapsy-desktop-dev.sqlite3->operational.sqlite3',
      'recapsy-desktop-dev.sqlite3-wal->operational.sqlite3-wal',
      'recapsy-desktop-dev.sqlite3-shm->operational.sqlite3-shm',
    ]);
  });

  it('does not overwrite or merge when the target database exists', () => {
    let renameCalls = 0;

    expect(
      migrateLegacyOperationalDatabase(DIRECTORY, {
        exists(filePath) {
          return filePath === path.join(DIRECTORY, 'operational.sqlite3');
        },
        rename() {
          renameCalls += 1;
        },
      }),
    ).toBe('target_exists');
    expect(renameCalls).toBe(0);
  });

  it('fails closed when the target and legacy databases both exist', () => {
    expect(() =>
      migrateLegacyOperationalDatabase(DIRECTORY, {
        exists(filePath) {
          return (
            filePath === path.join(DIRECTORY, 'operational.sqlite3') ||
            filePath === path.join(DIRECTORY, 'recapsy-desktop-dev.sqlite3')
          );
        },
        rename() {
          throw new Error('must not merge databases');
        },
      }),
    ).toThrow('Both operational and legacy databases exist');
  });

  it('rolls back already-moved files and fails closed when a sidecar move fails', () => {
    const existing = new Set([
      path.join(DIRECTORY, 'recapsy-desktop-dev.sqlite3'),
      path.join(DIRECTORY, 'recapsy-desktop-dev.sqlite3-wal'),
    ]);
    const moves: string[] = [];

    expect(() =>
      migrateLegacyOperationalDatabase(DIRECTORY, {
        exists(filePath) {
          return existing.has(filePath);
        },
        rename(from, to) {
          moves.push(`${path.basename(from)}->${path.basename(to)}`);
          if (from.endsWith('-wal')) {
            throw new Error('wal move failed');
          }
        },
      }),
    ).toThrow('wal move failed');
    expect(moves).toEqual([
      'recapsy-desktop-dev.sqlite3->operational.sqlite3',
      'recapsy-desktop-dev.sqlite3-wal->operational.sqlite3-wal',
      'operational.sqlite3->recapsy-desktop-dev.sqlite3',
    ]);
  });

  it('honors an explicit database path without touching legacy files', () => {
    let existsCalls = 0;

    expect(
      prepareOperationalDatabase({
        directory: DIRECTORY,
        fileSystem: {
          exists() {
            existsCalls += 1;
            return true;
          },
          rename() {
            throw new Error('must not migrate an explicit path');
          },
        },
        overridePath: '/private/tmp/acceptance.sqlite3',
      }),
    ).toBe('/private/tmp/acceptance.sqlite3');
    expect(existsCalls).toBe(0);
  });

  it('does not replace an explicitly empty database path with the default', () => {
    expect(
      prepareOperationalDatabase({
        directory: DIRECTORY,
        overridePath: '',
      }),
    ).toBe('');
  });
});
