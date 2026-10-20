'use strict';

const path = require('node:path');
const { WebContentsView, ipcMain } = require('electron');
const { getSettings } = require('./settings');
const { getTheme } = require('./themes');

/**
 * Dialogos JS (alert / confirm / prompt) al estilo Chrome.
 *
 * Electron los pinta por defecto como un MessageBox nativo de Windows. Aqui se
 * sustituye ese manejador interno (`-run-dialog`) por una vista encima de la
 * pestana: el script de la pagina sigue pausado hasta que el usuario responde,
 * pero el cuadro vive dentro de Orbit y usa el tema activo.
 */

const wired = new WeakSet();
const overlayBySender = new WeakMap();
let ipcReady = false;

function ensureIpc() {
  if (ipcReady) return;
  ipcReady = true;
  ipcMain.handle('js-dialog:reply', (event, result) => {
    overlayBySender.get(event.sender)?.handleReply(result);
  });
}

function dialogTypeOf(value) {
  if (value === 1 || value === 'confirm') return 'confirm';
  if (value === 2 || value === 'prompt') return 'prompt';
  return 'alert';
}

function originOf(info, fallbackUrl) {
  try {
    const frame = info?.frame;
    if (frame?.origin && frame.origin !== 'file://') return String(frame.origin);
    if (frame?.url) return String(frame.url);
  } catch {
    /* frame ya destruido */
  }
  return String(fallbackUrl || '');
}

function hostLabel(origin) {
  try {
    const url = new URL(origin);
    if (url.protocol === 'orbit:') return 'Orbit';
    if (url.protocol === 'file:') return 'Este archivo';
    return url.host || url.href;
  } catch {
    return origin ? String(origin) : 'Esta página';
  }
}

function payloadOf(info, tabUrl, showSuppress) {
  const type = dialogTypeOf(info?.dialogType);
  const origin = originOf(info, tabUrl);
  return {
    type,
    origin,
    title: `${hostLabel(origin)} dice`,
    message: String(info?.messageText ?? ''),
    defaultPrompt: String(info?.defaultPromptText ?? ''),
    showCancel: type === 'confirm' || type === 'prompt',
    showPrompt: type === 'prompt',
    showSuppress: Boolean(showSuppress),
    theme: chromeVars(),
  };
}

/** Vista translucida encima del hueco de la pagina. */
class DialogOverlay {
  /**
   * @param {import('electron').BrowserWindow} window
   * @param {() => {x:number,y:number,width:number,height:number,radius?:number}} getBounds
   */
  constructor(window, getBounds) {
    this.window = window;
    this.getBounds = getBounds;
    this.view = null;
    this.ready = null;
    this.open = false;
    this.onReply = null;
  }

  async ensure() {
    if (this.view && !this.view.webContents.isDestroyed()) return this.ready;
    ensureIpc();
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'js-dialog.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    view.setBackgroundColor('#00000000');
    if (typeof view.setVisible === 'function') view.setVisible(false);
    this.view = view;
    overlayBySender.set(view.webContents, this);
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.ready = view.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'pages', 'dialog', 'index.html'));
    return this.ready;
  }

  async show(payload) {
    if (!this.window || this.window.isDestroyed()) return;
    await this.ensure();
    if (!this.view || this.view.webContents.isDestroyed()) return;
    this.open = true;
    this.layout();
    try {
      this.window.contentView.addChildView(this.view);
    } catch {
      /* ya estaba */
    }
    if (typeof this.view.setVisible === 'function') this.view.setVisible(true);
    this.view.webContents.send('js-dialog:show', payload);
    try {
      this.view.webContents.focus();
    } catch {
      /* sin foco */
    }
  }

  layout() {
    if (!this.view || !this.open) return;
    const b = this.getBounds() || { x: 0, y: 0, width: 800, height: 600 };
    this.view.setBounds({
      x: Math.round(b.x) || 0,
      y: Math.round(b.y) || 0,
      width: Math.max(1, Math.round(b.width) || 1),
      height: Math.max(1, Math.round(b.height) || 1),
    });
    if (typeof this.view.setBorderRadius === 'function') {
      this.view.setBorderRadius(Math.round(b.radius) || 0);
    }
  }

  raise() {
    if (!this.view || !this.open || !this.window || this.window.isDestroyed()) return;
    try {
      this.window.contentView.addChildView(this.view);
    } catch {
      /* ventana cerrada */
    }
  }

  hide() {
    this.open = false;
    if (!this.view) return;
    if (typeof this.view.setVisible === 'function') this.view.setVisible(false);
  }

  handleReply(result) {
    this.onReply?.(result);
  }

  dispose() {
    this.open = false;
    this.onReply = null;
    if (!this.view) return;
    try {
      this.window?.contentView?.removeChildView(this.view);
    } catch {
      /* ya no esta */
    }
    try {
      if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
    } catch {
      /* ya cerrado */
    }
    this.view = null;
  }
}

function createTabDialogs(tabs) {
  const overlay = new DialogOverlay(tabs.window, () => ({
    ...tabs.pageBounds,
    radius: tabs.borderRadius,
  }));

  overlay.onReply = (result) => {
    const tab = tabs.tabs.get(tabs.activeId);
    finish(tab, Boolean(result?.ok), String(result?.value ?? ''), Boolean(result?.suppress));
    sync();
  };

  function finish(tab, ok, value, suppress) {
    const dlg = tab?.jsDialog;
    if (!dlg) return;
    tab.jsDialog = null;
    if (suppress && dlg.origin) {
      tab.dialogMute = tab.dialogMute || new Set();
      tab.dialogMute.add(dlg.origin);
    }
    try {
      dlg.callback(ok, value);
    } catch {
      /* ya respondido */
    }
  }

  function sync() {
    const tab = tabs.tabs.get(tabs.activeId);
    if (tab?.jsDialog) overlay.show(tab.jsDialog.payload);
    else overlay.hide();
  }

  return {
    overlay,
    isOpen: () => overlay.open,
    get overlayContents() {
      return overlay.view?.webContents ?? null;
    },
    run(tab, info, callback) {
      if (!tab) return callback(false, '');
      const prefs = tab.view?.webContents?.getLastWebPreferences?.();
      if (prefs?.disableDialogs) return callback(false, '');

      const origin = originOf(info, tab.url);
      if (tab.dialogMute?.has(origin)) return callback(false, '');

      tab.dialogBurst = (tab.dialogBurst || 0) + 1;
      tab.jsDialog = {
        callback,
        origin,
        payload: payloadOf(info, tab.url, tab.dialogBurst > 1),
      };
      sync();
    },
    dismiss(tab) {
      finish(tab, false, '', false);
      sync();
    },
    onNavigate(tab) {
      if (tab) tab.dialogBurst = 0;
      this.dismiss(tab);
    },
    sync,
    layout: () => overlay.layout(),
    raise: () => overlay.raise(),
    dispose() {
      for (const tab of tabs.tabs.values()) finish(tab, false, '', false);
      overlay.dispose();
    },
  };
}

function attachPageDialogs(wc, tab) {
  if (!wc || wc.isDestroyed() || wired.has(wc)) return;
  wired.add(wc);
  try {
    wc.removeAllListeners('-run-dialog');
    wc.removeAllListeners('-cancel-dialogs');
  } catch {
    /* Electron puede reservar el nombre */
  }

  wc.on('-run-dialog', (info, callback) => {
    const mgr = tab.owner;
    if (!mgr?.jsDialogs) return callback(false, '');
    mgr.jsDialogs.run(tab, info, callback);
  });
  wc.on('-cancel-dialogs', () => {
    tab.owner?.jsDialogs?.onNavigate(tab);
  });
}

function attachWindowDialogs(window) {
  if (!window || window.isDestroyed()) return;
  const wc = window.webContents;
  if (!wc || wired.has(wc)) return;
  wired.add(wc);

  const overlay = new DialogOverlay(window, () => {
    const [width, height] = window.getContentSize();
    return { x: 0, y: 0, width, height, radius: 0 };
  });
  let pending = null;

  overlay.onReply = (result) => {
    const dlg = pending;
    pending = null;
    overlay.hide();
    try {
      dlg?.callback(Boolean(result?.ok), String(result?.value ?? ''));
    } catch {
      /* ya respondido */
    }
  };

  try {
    wc.removeAllListeners('-run-dialog');
    wc.removeAllListeners('-cancel-dialogs');
  } catch {
    /* */
  }

  wc.on('-run-dialog', (info, callback) => {
    pending = { callback };
    overlay.show(payloadOf(info, wc.getURL(), false));
  });
  wc.on('-cancel-dialogs', () => {
    const dlg = pending;
    pending = null;
    overlay.hide();
    try {
      dlg?.callback(false, '');
    } catch {
      /* */
    }
  });

  window.on('resize', () => overlay.layout());
  window.on('closed', () => overlay.dispose());
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

module.exports = { createTabDialogs, attachPageDialogs, attachWindowDialogs };
