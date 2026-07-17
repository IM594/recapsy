import { describe, expect, it } from 'bun:test';
import {
  DESKTOP_APPLICATION_NAME,
  configureDesktopApplicationProfile,
  resolveDesktopUserDataPath,
} from '../application-profile';

describe('desktop application profile', () => {
  it('uses one product-named user-data directory independent of the launch layout', () => {
    expect(DESKTOP_APPLICATION_NAME).toBe('Recapsy');
    expect(resolveDesktopUserDataPath('/Users/example/Library/Application Support')).toBe(
      '/Users/example/Library/Application Support/Recapsy',
    );
  });

  it('configures the product profile before the runtime accesses user data', () => {
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

    configureDesktopApplicationProfile(app);

    expect(calls).toEqual([
      ['setName', 'Recapsy'],
      ['getPath', 'appData'],
      ['setPath', 'userData:/Users/example/Library/Application Support/Recapsy'],
    ]);
  });
});
