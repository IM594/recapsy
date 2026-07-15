import { describe, expect, it } from 'bun:test';
import { resolveDesktopApplicationPaths } from '../application-layout';

describe('desktop application layout', () => {
  it('resolves login assets from the Electron application root', () => {
    expect(
      resolveDesktopApplicationPaths('/Applications/Recapsy.app/Contents/Resources/app.asar'),
    ).toEqual({
      loginWindowHtmlPath:
        '/Applications/Recapsy.app/Contents/Resources/app.asar/dist/auth/login-window.html',
      loginWindowPreloadPath:
        '/Applications/Recapsy.app/Contents/Resources/app.asar/dist/auth/login-preload.js',
    });
  });
});
