import path from 'node:path';

export const DESKTOP_APPLICATION_NAME = 'Recapsy';

export type DesktopApplicationProfileHost = {
  getPath(name: 'appData'): string;
  setName(name: string): void;
  setPath(name: 'userData', value: string): void;
};

/** Builds the stable local profile path shared by development and releases. */
export function resolveDesktopUserDataPath(appDataPath: string): string {
  return path.join(appDataPath, DESKTOP_APPLICATION_NAME);
}

/** Sets the product-owned local profile before any userData consumer starts. */
export function configureDesktopApplicationProfile(app: DesktopApplicationProfileHost): void {
  app.setName(DESKTOP_APPLICATION_NAME);
  app.setPath('userData', resolveDesktopUserDataPath(app.getPath('appData')));
}
