import path from 'node:path';

export type DesktopApplicationPaths = {
  loginWindowHtmlPath: string;
  loginWindowPreloadPath: string;
  mainWindowHtmlPath: string;
  mainWindowPreloadPath: string;
};

/** Resolves renderer assets identically from a package directory or app.asar. */
export function resolveDesktopApplicationPaths(packageRoot: string): DesktopApplicationPaths {
  const authDirectory = path.join(packageRoot, 'dist', 'auth');
  const shellDirectory = path.join(packageRoot, 'dist', 'shell');
  return {
    loginWindowHtmlPath: path.join(authDirectory, 'login-window.html'),
    loginWindowPreloadPath: path.join(authDirectory, 'login-preload.js'),
    mainWindowHtmlPath: path.join(shellDirectory, 'main-window.html'),
    mainWindowPreloadPath: path.join(shellDirectory, 'main-preload.js'),
  };
}
