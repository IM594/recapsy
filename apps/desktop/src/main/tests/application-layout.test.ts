import { describe, expect, it } from 'bun:test';
import { resolveDesktopApplicationPaths } from '../application-layout';

describe('desktop application layout', () => {
  it('resolves login and main-window assets from the Electron application root', () => {
    expect(
      resolveDesktopApplicationPaths(
        '/Applications/Recapsy Preview.app/Contents/Resources/app.asar',
      ),
    ).toEqual({
      loginWindowHtmlPath:
        '/Applications/Recapsy Preview.app/Contents/Resources/app.asar/dist/auth/login-window.html',
      loginWindowPreloadPath:
        '/Applications/Recapsy Preview.app/Contents/Resources/app.asar/dist/auth/login-preload.js',
      mainWindowHtmlPath:
        '/Applications/Recapsy Preview.app/Contents/Resources/app.asar/dist/shell/main-window.html',
      mainWindowPreloadPath:
        '/Applications/Recapsy Preview.app/Contents/Resources/app.asar/dist/shell/main-preload.js',
    });
  });

  it('resolves renderer assets from the Desktop package root during development', () => {
    expect(resolveDesktopApplicationPaths('/Users/example/Projects/recapsy/apps/desktop')).toEqual({
      loginWindowHtmlPath:
        '/Users/example/Projects/recapsy/apps/desktop/dist/auth/login-window.html',
      loginWindowPreloadPath:
        '/Users/example/Projects/recapsy/apps/desktop/dist/auth/login-preload.js',
      mainWindowHtmlPath:
        '/Users/example/Projects/recapsy/apps/desktop/dist/shell/main-window.html',
      mainWindowPreloadPath:
        '/Users/example/Projects/recapsy/apps/desktop/dist/shell/main-preload.js',
    });
  });
});
