'use strict';

const { shell } = require('electron');
const { attachWindowDialogs } = require('./js-dialogs');

/**
 * Ventanas que abre una pagina (`window.open`, OAuth, etc.).
 *
 * Google, Firebase y muchos SSO necesitan un popup de verdad: la pagina
 * original espera `window.opener.postMessage` y `window.close()`. Si las
 * convertimos en una pestana, el opener se pierde y el inicio de sesion
 * se queda a medias despues de elegir la cuenta.
 */

function isPopupRequest({ disposition, features, frameName }) {
  if (disposition === 'new-window') return true;
  if (disposition === 'foreground-tab' || disposition === 'background-tab' || disposition === 'save-to-disk') {
    return false;
  }
  const feat = String(features || '');
  if (/\b(width|height|popup)\s*=/i.test(feat)) return true;
  const name = String(frameName || '');
  return Boolean(name && !/^_?(blank|self|parent|top)$/i.test(name) && feat);
}

function parseFeatures(features) {
  const out = {};
  for (const part of String(features || '').split(/[,;]/)) {
    const [rawKey, rawVal] = part.split('=').map((s) => String(s || '').trim());
    if (!rawKey) continue;
    const num = Number(rawVal);
    out[rawKey.toLowerCase()] = Number.isFinite(num) ? num : rawVal;
  }
  return out;
}

function popupBounds(features, parent) {
  const f = parseFeatures(features);
  const width = clamp(f.width || 520, 320, 1280);
  const height = clamp(f.height || 680, 400, 1000);
  const area = parent && !parent.isDestroyed() ? parent.getBounds() : null;
  const x = Number.isFinite(f.left)
    ? f.left
    : area
      ? Math.round(area.x + (area.width - width) / 2)
      : undefined;
  const y = Number.isFinite(f.top)
    ? f.top
    : area
      ? Math.round(area.y + (area.height - height) / 2)
      : undefined;
  return { width, height, x, y };
}

const wired = new WeakSet();

/**
 * @param {import('electron').WebContents} wc
 * @param {{getParentWindow?: () => import('electron').BrowserWindow|null, openTab?: (url: string, opts?: object) => void}} hooks
 */
function attachWindowOpen(wc, hooks = {}) {
  if (!wc || wc.isDestroyed() || wired.has(wc)) return;
  wired.add(wc);

  const { getParentWindow, openTab } = hooks;

  wc.setWindowOpenHandler((details) => {
    const url = String(details.url || '');
    if (/^javascript:/i.test(url)) return { action: 'deny' };

    if (isPopupRequest(details)) {
      const parent = getParentWindow?.() ?? null;
      const bounds = popupBounds(details.features, parent);
      return {
        action: 'allow',
        outlivesOpener: false,
        overrideBrowserWindowOptions: {
          ...bounds,
          // Sin parent: en Windows 10 una hija de ventana transparente hereda
          // el canal alfa y Google se ve irreconocible.
          frame: true,
          transparent: false,
          backgroundColor: '#ffffff',
          autoHideMenuBar: true,
          minimizable: true,
          maximizable: false,
          fullscreenable: false,
          skipTaskbar: false,
          modal: false,
          show: true,
        },
      };
    }

    if (openTab && (details.disposition === 'foreground-tab' || details.disposition === 'background-tab' || details.disposition === 'default')) {
      if (url && url !== 'about:blank' && /^(https?|orbit):/i.test(url)) {
        openTab(url, { active: details.disposition !== 'background-tab' });
      }
      return { action: 'deny' };
    }

    return { action: 'deny' };
  });

  wc.on('did-create-window', (child) => {
    if (!child || child.isDestroyed()) return;
    child.setMenuBarVisibility(false);
    const childWc = child.webContents;
    attachWindowOpen(childWc, {
      getParentWindow: () => child,
      openTab,
    });
    attachWindowDialogs(child);
    childWc.on('will-navigate', (event, nextUrl) => {
      if (!/^(https?|orbit|about|file|data|blob):/i.test(nextUrl)) {
        event.preventDefault();
        shell.openExternal(nextUrl).catch(() => {});
      }
    });
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

module.exports = { attachWindowOpen, isPopupRequest };
