import path from 'node:path';
import { app, Menu, Tray } from 'electron';
import { menuBarMenu } from './menu-bar/menu.js';

app.on('ready', () => {
  if (!app.isPackaged) {
    app.dock?.hide();
  }

  const iconPath = path.join(import.meta.dirname, '..', 'assets', 'menuBarTemplate.png');
  const tray = new Tray(iconPath);
  tray.setContextMenu(Menu.buildFromTemplate(menuBarMenu(app.getVersion())));
});
