import path from 'node:path';

export type DesktopApplicationPaths = {
  loginWindowHtmlPath: string;
  loginWindowPreloadPath: string;
  mainWindowHtmlPath: string;
  mainWindowPreloadPath: string;
};

/** Resolves renderer assets identically from a package directory or app.asar. */
export function resolveDesktopApplicationPaths(appPath: string): DesktopApplicationPaths {
  const packageRoot = resolveDesktopPackageRoot(appPath);
  const authDirectory = path.join(packageRoot, 'dist', 'auth');
  const shellDirectory = path.join(packageRoot, 'dist', 'shell');
  return {
    loginWindowHtmlPath: path.join(authDirectory, 'login-window.html'),
    loginWindowPreloadPath: path.join(authDirectory, 'login-preload.js'),
    mainWindowHtmlPath: path.join(shellDirectory, 'main-window.html'),
    mainWindowPreloadPath: path.join(shellDirectory, 'main-preload.js'),
  };
}

/** Resolves Electron's runtime app path to the Desktop package root. */
export function resolveDesktopPackageRoot(appPath: string): string {
  const normalizedPath = path.normalize(appPath);
  const parentDirectory = path.dirname(normalizedPath);

  // `electron dist/main/electron-entry.js` treats `dist/main` as appPath in
  // development, whereas packaged Electron returns the app.asar root.
  if (path.basename(normalizedPath) === 'main' && path.basename(parentDirectory) === 'dist') {
    return path.dirname(parentDirectory);
  }

  return normalizedPath;
}
