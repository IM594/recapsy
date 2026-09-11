import type { MenuItemConstructorOptions } from 'electron';

export function menuBarMenu(version: string): MenuItemConstructorOptions[] {
  return [{ label: `Recapsy ${version}`, enabled: false }, { type: 'separator' }, { role: 'quit' }];
}
