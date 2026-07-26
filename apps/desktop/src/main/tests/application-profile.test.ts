import { describe, expect, it } from 'bun:test';
import {
  DESKTOP_APPLICATION_NAME,
  configureDesktopApplicationProfile,
  migrateLegacyDesktopApplicationProfile,
  resolveDesktopUserDataPath,
} from '../application-profile';

describe('desktop application profile', () => {
  it('separates the preview display name from the stable technical profile directory', () => {
    expect(DESKTOP_APPLICATION_NAME).toBe('Recapsy Preview');
    expect(resolveDesktopUserDataPath('/Users/example/Library/Application Support')).toBe(
      '/Users/example/Library/Application Support/one.recapsy.desktop',
    );
  });

  it('atomically migrates the legacy profile when the stable profile does not exist', () => {
    const calls: string[] = [];

    expect(
      migrateLegacyDesktopApplicationProfile('/Users/example/Library/Application Support', {
        exists(path) {
          calls.push(`exists:${path}`);
          return path.endsWith('/Recapsy');
        },
        rename(from, to) {
          calls.push(`rename:${from}->${to}`);
        },
      }),
    ).toBe('migrated');
    expect(calls).toEqual([
      'exists:/Users/example/Library/Application Support/one.recapsy.desktop',
      'exists:/Users/example/Library/Application Support/Recapsy',
      'rename:/Users/example/Library/Application Support/Recapsy->/Users/example/Library/Application Support/one.recapsy.desktop',
    ]);
  });

  it('does not merge or overwrite when the stable profile already exists', () => {
    let renameCalls = 0;

    expect(
      migrateLegacyDesktopApplicationProfile('/Users/example/Library/Application Support', {
        exists(path) {
          return path.endsWith('/one.recapsy.desktop');
        },
        rename() {
          renameCalls += 1;
        },
      }),
    ).toBe('target_exists');
    expect(renameCalls).toBe(0);
  });

  it('fails closed when the stable and legacy profiles both exist', () => {
    expect(() =>
      migrateLegacyDesktopApplicationProfile('/Users/example/Library/Application Support', {
        exists() {
          return true;
        },
        rename() {
          throw new Error('must not merge profiles');
        },
      }),
    ).toThrow('Both stable and legacy desktop profiles exist');
  });

  it('fails closed when the legacy profile cannot be migrated', () => {
    expect(() =>
      migrateLegacyDesktopApplicationProfile('/Users/example/Library/Application Support', {
        exists(path) {
          return path.endsWith('/Recapsy');
        },
        rename() {
          throw new Error('permission denied');
        },
      }),
    ).toThrow('permission denied');
  });

  it('migrates before configuring the product profile', () => {
    const calls: Array<[string, string?]> = [];
    const app = {
      getPath(name: 'appData') {
        calls.push(['getPath', name]);
        return '/Users/example/Library/Application Support';
      },
      setName(name: string) {
        calls.push(['setName', name]);
      },
      setPath(name: 'userData', value: string) {
        calls.push(['setPath', `${name}:${value}`]);
      },
    };

    configureDesktopApplicationProfile(app, {
      exists(path) {
        calls.push(['exists', path]);
        return path.endsWith('/Recapsy');
      },
      rename(from, to) {
        calls.push(['rename', `${from}->${to}`]);
      },
    });

    expect(calls).toEqual([
      ['setName', 'Recapsy Preview'],
      ['getPath', 'appData'],
      ['exists', '/Users/example/Library/Application Support/one.recapsy.desktop'],
      ['exists', '/Users/example/Library/Application Support/Recapsy'],
      [
        'rename',
        '/Users/example/Library/Application Support/Recapsy->/Users/example/Library/Application Support/one.recapsy.desktop',
      ],
      ['setPath', 'userData:/Users/example/Library/Application Support/one.recapsy.desktop'],
    ]);
  });
});
