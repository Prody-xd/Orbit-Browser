'use strict';

const path = require('node:path');
const { BrowserWindow, screen, ipcMain, shell, app } = require('electron');
const { getSettings } = require('./settings');
const { getTheme } = require('./themes');

let popup = null;

function showDownloadsPopup({ parent, downloads, anchor = {} }) {
  if (!parent || parent.isDestroyed() || !downloads) return;
  closeDownloadsPopup();

  const theme = chromeVars();
  const snapNow = () => downloads.snapshot();
  const snap = snapNow();
  const size = popupSize(snap);
  const pos = placePopup(parent, anchor, size);

  popup = new BrowserWindow({
    parent,
    modal: false,
    frame: false,
    transparent: true,
    width: size.width,
    height: size.height,
    x: pos.x,
    y: pos.y,
    show: false,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    backgroundColor: '#00000000',
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'downloads-popup.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  popup.setMenuBarVisibility(false);
  popup.loadFile(path.join(__dirname, '..', 'renderer', 'downloads-popup.html'));

  const send = (channel, payload) => {
    if (!popup || popup.isDestroyed()) return;
    popup.webContents.send(channel, payload);
  };

  popup.webContents.once('did-finish-load', () => {
    send('downloads-popup:init', { theme, snap });
    if (!popup.isDestroyed()) popup.show();
  });

  const onUpdate = (next) => {
    send('downloads-popup:update', next);
    if (popup && !popup.isDestroyed()) {
      const nextSize = popupSize(next);
      const bounds = popup.getBounds();
      if (Math.abs(bounds.height - nextSize.height) > 8) {
        popup.setBounds({ ...bounds, height: nextSize.height });
      }
    }
  };
  downloads.on('update', onUpdate);

  const onOpen = (_e, id) => {
    const item = snapNow().items.find((entry) => entry.id === id);
    if (item?.path) shell.openPath(item.path);
  };
  const onShow = (_e, id) => {
    const item = snapNow().items.find((entry) => entry.id === id);
    if (item?.path) shell.showItemInFolder(item.path);
  };
  const onPause = (_e, id) => downloads.pause(id);
  const onResume = (_e, id) => downloads.resume(id);
  const onCancel = (_e, id) => downloads.cancel(id);
  const onClear = () => downloads.clearDone();
  const onFolder = () => shell.openPath(app.getPath('downloads'));
  const onClose = () => closeDownloadsPopup();

  ipcMain.on('downloads-popup:open', onOpen);
  ipcMain.on('downloads-popup:show', onShow);
  ipcMain.on('downloads-popup:pause', onPause);
  ipcMain.on('downloads-popup:resume', onResume);
  ipcMain.on('downloads-popup:cancel', onCancel);
  ipcMain.on('downloads-popup:clear', onClear);
  ipcMain.on('downloads-popup:folder', onFolder);
  ipcMain.on('downloads-popup:close', onClose);

  popup.on('blur', () => closeDownloadsPopup());
  popup.on('closed', () => {
    downloads.off('update', onUpdate);
    ipcMain.removeListener('downloads-popup:open', onOpen);
    ipcMain.removeListener('downloads-popup:show', onShow);
    ipcMain.removeListener('downloads-popup:pause', onPause);
    ipcMain.removeListener('downloads-popup:resume', onResume);
    ipcMain.removeListener('downloads-popup:cancel', onCancel);
    ipcMain.removeListener('downloads-popup:clear', onClear);
    ipcMain.removeListener('downloads-popup:folder', onFolder);
    ipcMain.removeListener('downloads-popup:close', onClose);
    popup = null;
  });
}

function closeDownloadsPopup() {
  if (!popup || popup.isDestroyed()) {
    popup = null;
    return;
  }
  popup.close();
  popup = null;
}

function popupSize(snap) {
  const rows = Math.min(snap.items?.length ?? 0, 8);
  const empty = rows === 0 ? 44 : 0;
  const height = Math.min(520, 52 + empty + rows * 72 + 88);
  return { width: 380, height };
}

function placePopup(parent, anchor, size) {
  const content = parent.getContentBounds();
  const zoom = parent.webContents.getZoomFactor() || 1;
  let x = Math.round(content.x + Number(anchor.x ?? 0) * zoom - size.width);
  let y = Math.round(content.y + Number(anchor.y ?? 0) * zoom);
  const area = screen.getDisplayMatching(content).workArea;
  if (x < area.x + 8) x = area.x + 8;
  if (x + size.width > area.x + area.width - 8) x = area.x + area.width - size.width - 8;
  if (y + size.height > area.y + area.height - 8) y = Math.max(area.y + 8, y - size.height - 36);
  return { x, y };
}

function chromeVars() {
  const appearance = getSettings().appearance ?? {};
  const theme = getTheme(appearance.theme);
  const c = theme?.colors ?? {};
  const accent = appearance.accent || c.accent || '#7aa2f7';
  const opaque = appearance.surface === 'opaque';
  const neon = Boolean(theme?.neon);
  return {
    '--rgb-base': rgbTriplet(c.base ?? '#0f1017'),
    '--rgb-chrome': rgbTriplet(c.chrome ?? c.base ?? '#171826'),
    '--rgb-elevated': rgbTriplet(c.elevated ?? c.chrome ?? '#1f2133'),
    '--rgb-border': rgbTriplet(c.border ?? '#2b2e42'),
    '--rgb-accent': rgbTriplet(accent),
    '--c-text': c.text ?? '#c9d1e6',
    '--c-muted': c.muted ?? '#79839e',
    '--c-accent': accent,
    '--c-danger': c.danger ?? '#f7768e',
    '--alpha-chrome': String(opaque ? 1 : 0.94),
    '--radius': `${Number(appearance.radius) || 14}px`,
    '--blur': `${opaque ? 0 : Number(appearance.chromeBlur) || 20}px`,
    '--glow-strength': neon ? '18px' : '0px',
    '--glow-alpha': neon ? '0.62' : '0',
    '--font-scale': String(appearance.fontScale ?? 1),
  };
}

function rgbTriplet(hex) {
  const clean = String(hex || '').replace('#', '').trim();
  const full = clean.length === 3 ? clean.replace(/./g, (ch) => ch + ch) : clean;
  const num = Number.parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(num)) return '0 0 0';
  return `${(num >> 16) & 255} ${(num >> 8) & 255} ${num & 255}`;
}

module.exports = { showDownloadsPopup, closeDownloadsPopup };
