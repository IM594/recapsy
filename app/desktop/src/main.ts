import { app, Menu, nativeImage, Tray } from 'electron';
import { menuBarMenu } from './menu-bar/menu.js';

app.on('ready', () => {
  app.dock?.hide();

  const tray = new Tray(nativeImage.createEmpty());
  tray.setContextMenu(Menu.buildFromTemplate(menuBarMenu(app.getVersion())));
});
