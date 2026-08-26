'use strict';

const path = require('node:path');
const { BrowserWindow, screen, ipcMain, clipboard } = require('electron');
const { getSettings } = require('./settings');
const { getTheme } = require('./themes');

let popup = null;

/**
 * Panel flotante de fetch, pintado con el mismo vidrio que el chrome.
 *
 * El menu nativo de Windows no hereda tema ni translucidez. Una ventana hija
 * transparente si: se coloca sobre la pagina nativa y usa las variables CSS
 * del tema activo.
 */
function showNetworkPopup({ parent, network, anchor = {} }) {
  if (!parent || parent.isDestroyed()) return;
  closeNetworkPopup();

  const theme = chromeVars();
  const snap = network.activeSnapshot();
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
      preload: path.join(__dirname, '..', 'preload', 'network-popup.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  popup.setMenuBarVisibility(false);
  popup.loadFile(path.join(__dirname, '..', 'renderer', 'network-popup.html'));

  const send = (channel, payload) => {
    if (!popup || popup.isDestroyed()) return;
    popup.webContents.send(channel, payload);
  };

  popup.webContents.once('did-finish-load', () => {
    send('network-popup:init', { theme, snap });
    if (!popup.isDestroyed()) popup.show();
  });

  const onUpdate = (next) => {
    send('network-popup:update', next);
    if (popup && !popup.isDestroyed()) {
      const nextSize = popupSize(next);
      const bounds = popup.getBounds();
      if (Math.abs(bounds.height - nextSize.height) > 8) {
        popup.setBounds({ ...bounds, height: nextSize.height });
      }
    }
  };
  network.on('update', onUpdate);

  const onCopy = (_e, text) => clipboard.writeText(String(text ?? ''));
  const onCopyAll = () => {
    const current = network.activeSnapshot();
    clipboard.writeText(current.endpoints.map((entry) => `${entry.count}\t${entry.key}`).join('\n'));
  };
  const onReset = () => network.reset(network.tabs.activeId);
  const onClose = () => closeNetworkPopup();

  ipcMain.on('network-popup:copy', onCopy);
  ipcMain.on('network-popup:copy-all', onCopyAll);
  ipcMain.on('network-popup:reset', onReset);
  ipcMain.on('network-popup:close', onClose);

  popup.on('blur', () => closeNetworkPopup());
  popup.on('closed', () => {
    network.off('update', onUpdate);
    ipcMain.removeListener('network-popup:copy', onCopy);
    ipcMain.removeListener('network-popup:copy-all', onCopyAll);
    ipcMain.removeListener('network-popup:reset', onReset);
    ipcMain.removeListener('network-popup:close', onClose);
    popup = null;
  });
}

function closeNetworkPopup() {
  if (!popup || popup.isDestroyed()) {
    popup = null;
    return;
  }
  popup.close();
  popup = null;
}

function popupSize(snap) {
  const rows = Math.min(snap.endpoints?.length ?? 0, 22);
  const empty = rows === 0 ? 44 : 0;
  const height = Math.min(460, 52 + empty + rows * 34 + 88);
  return { width: 428, height };
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
  return `${(num >> 16) & 255} ${(num >> 8) & 255} ${(num >> 0) & 255}`;
}

module.exports = { showNetworkPopup, closeNetworkPopup };
