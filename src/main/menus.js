'use strict';

const { Menu, clipboard, shell, dialog } = require('electron');
const { openPageSource } = require('./source-view');

/**
 * Menus contextuales nativos.
 *
 * Se hacen con `Menu` de Electron y no con HTML a proposito: la pagina es una
 * vista nativa compuesta por encima del chrome, asi que un menu hecho en HTML
 * quedaria tapado por la propia pagina. Los menus nativos flotan sobre todo.
 *
 * El de la pagina sigue el orden de Vivaldi: navegacion, la pagina, y las
 * herramientas de desarrollo (fuente, marco, inspector) en un submenu.
 */

/** Menu al hacer clic derecho dentro de una pagina. */
function showPageMenu({ tabs, tabId, params, window }) {
  const items = [];
  const tab = tabs.tabs.get(tabId);
  const wc = tab?.view?.webContents;
  const pageUrl = tab?.url ?? params.pageURL ?? '';
  const frameUrl = frameUrlOf(params);
  const inFrame = isSubframe(params, pageUrl) && Boolean(frameUrl);

  if (params.linkURL) {
    items.push(
      { label: 'Abrir enlace en pestaña nueva', click: () => tabs.create(params.linkURL, { active: false }) },
      { label: 'Abrir enlace y cambiar a ella', click: () => tabs.create(params.linkURL, { active: true }) },
      { label: 'Copiar dirección del enlace', click: () => clipboard.writeText(params.linkURL) },
      { label: 'Abrir en el navegador del sistema', click: () => shell.openExternal(params.linkURL) },
      { type: 'separator' },
    );
  }

  if (params.mediaType === 'image' && params.srcURL) {
    items.push(
      { label: 'Abrir imagen en pestaña nueva', click: () => tabs.create(params.srcURL, { active: true }) },
      { label: 'Copiar dirección de la imagen', click: () => clipboard.writeText(params.srcURL) },
      { type: 'separator' },
    );
  }

  if (params.isEditable) {
    items.push(
      { role: 'undo', label: 'Deshacer' },
      { role: 'redo', label: 'Rehacer' },
      { type: 'separator' },
      { role: 'cut', label: 'Cortar' },
      { role: 'copy', label: 'Copiar' },
      { role: 'paste', label: 'Pegar' },
      { role: 'selectAll', label: 'Seleccionar todo' },
      { type: 'separator' },
    );
  } else if (params.selectionText) {
    items.push(
      { role: 'copy', label: 'Copiar' },
      {
        label: `Buscar "${truncate(params.selectionText, 24)}"`,
        click: () => tabs.create(params.selectionText, { active: true }),
      },
      { type: 'separator' },
    );
  }

  items.push(
    {
      label: 'Atrás',
      accelerator: 'Alt+Left',
      enabled: Boolean(wc?.navigationHistory?.canGoBack()),
      click: () => tabs.goBack(tabId),
    },
    {
      label: 'Adelante',
      accelerator: 'Alt+Right',
      enabled: Boolean(wc?.navigationHistory?.canGoForward()),
      click: () => tabs.goForward(tabId),
    },
    { label: 'Recargar', accelerator: 'CommandOrControl+R', click: () => tabs.reload(tabId) },
    { type: 'separator' },
    { label: 'Copiar dirección de la página', click: () => clipboard.writeText(pageUrl) },
    { type: 'separator' },
    {
      label: 'Guardar como...',
      accelerator: 'CommandOrControl+S',
      enabled: Boolean(wc),
      click: () => savePageAs({ wc, window, url: pageUrl }),
    },
    { type: 'separator' },
    {
      label: 'Imprimir...',
      accelerator: 'CommandOrControl+P',
      enabled: Boolean(wc),
      click: () => wc.print(),
    },
    { type: 'separator' },
    {
      label: 'Dormir esta pestaña',
      click: () => tabs.sleep(tabId, { force: true }),
    },
    { type: 'separator' },
    {
      label: 'Herramientas de desarrollo',
      submenu: [
        {
          label: 'Validar',
          enabled: /^https?:/i.test(pageUrl),
          click: () => tabs.create(`https://validator.w3.org/nu/?doc=${encodeURIComponent(pageUrl)}`, { active: true }),
        },
        {
          label: 'Ver código fuente de la página',
          accelerator: 'CommandOrControl+U',
          click: () => openPageSource(tabs, { url: pageUrl, webContents: wc }),
        },
        {
          label: 'Ver código fuente del marco',
          enabled: inFrame,
          click: () => openPageSource(tabs, { url: frameUrl, frame: params.frame, webContents: wc }),
        },
        {
          label: 'Recargar marco',
          enabled: inFrame,
          click: () => reloadFrame(params.frame),
        },
        {
          label: 'Abrir marco en una pestaña nueva',
          enabled: inFrame,
          click: () => tabs.create(frameUrl, { active: true }),
        },
        {
          label: 'Inspeccionar',
          accelerator: 'CommandOrControl+Shift+I',
          click: () => wc?.openDevTools({ mode: 'detach' }),
        },
      ],
    },
  );

  Menu.buildFromTemplate(items).popup({ window });
}

/** Menu al hacer clic derecho en una pestana de la barra. */
function showTabMenu({ tabs, tabId, window }) {
  const tab = tabs.tabs.get(tabId);
  if (!tab) return;

  const items = [
    { label: 'Recargar', click: () => tabs.reload(tabId) },
    { label: 'Duplicar', click: () => tabs.create(tab.url, { active: true }) },
    { type: 'separator' },
    { label: tab.pinned ? 'Desfijar' : 'Fijar', click: () => tabs.setPinned(tabId, !tab.pinned) },
    {
      label: tab.sleeping ? 'Despertar' : 'Dormir',
      click: () => (tab.sleeping ? tabs.wake(tabId) : tabs.sleep(tabId, { force: true })),
    },
    {
      label: tab.muted ? 'Activar sonido' : 'Silenciar pestaña',
      click: () => tabs.setMuted(tabId, !tab.muted),
    },
    { label: 'Dormir las demás', click: () => tabs.sleepAllButActive() },
    { type: 'separator' },
    { label: 'Copiar dirección', click: () => clipboard.writeText(tab.url) },
    { type: 'separator' },
    { label: 'Cerrar', click: () => tabs.close(tabId) },
    {
      label: 'Cerrar las demás',
      click: () => {
        for (const id of [...tabs.order]) if (id !== tabId) tabs.close(id);
      },
    },
  ];

  Menu.buildFromTemplate(items).popup({ window });
}

function handlePageShortcut({ tabs, window, combo }) {
  const tab = tabs.tabs.get(tabs.activeId);
  const wc = tab?.view?.webContents;
  if (combo === 'ctrl+u') {
    openPageSource(tabs, { url: tab?.url, webContents: wc });
    return true;
  }
  if (combo === 'ctrl+shift+i') {
    wc?.openDevTools({ mode: 'detach' });
    return true;
  }
  if (combo === 'ctrl+p') {
    wc?.print();
    return true;
  }
  if (combo === 'ctrl+s') {
    savePageAs({ wc, window, url: tab?.url });
    return true;
  }
  return false;
}

async function savePageAs({ wc, window, url }) {
  if (!wc || wc.isDestroyed()) return;
  const result = await dialog.showSaveDialog(window, {
    title: 'Guardar como',
    defaultPath: filenameFromUrl(url),
    filters: [
      { name: 'Página web, completa', extensions: ['html', 'htm'] },
      { name: 'Solo HTML', extensions: ['html'] },
    ],
  });
  if (result.canceled || !result.filePath) return;
  try {
    await wc.savePage(result.filePath, 'HTMLComplete');
  } catch (err) {
    console.warn('[menu] no se pudo guardar la pagina:', err.message);
  }
}

function filenameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    if (last && /\.html?$/i.test(last)) return last;
    const host = parsed.hostname.replace(/^www\./, '') || 'pagina';
    return `${host}.html`;
  } catch {
    return 'pagina.html';
  }
}

function truncate(text, max) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

function frameUrlOf(params) {
  const fromFrame = (() => {
    try {
      return params.frame?.url;
    } catch {
      return '';
    }
  })();
  return String(params.frameURL || fromFrame || '').trim();
}

function isSubframe(params, pageUrl) {
  try {
    if (params.frame?.parent) return true;
  } catch {
    /* el frame ya no existe */
  }
  const frameURL = frameUrlOf(params);
  const top = String(params.pageURL || pageUrl || '').trim();
  return Boolean(frameURL && top && frameURL !== top);
}

function reloadFrame(frame) {
  if (!frame) return;
  try {
    if (typeof frame.reload === 'function') {
      frame.reload();
      return;
    }
  } catch {
    /* destruido */
  }
  try {
    frame.executeJavaScript('location.reload()', true).catch(() => {});
  } catch {
    /* sin acceso al marco */
  }
}

module.exports = { showPageMenu, showTabMenu, handlePageShortcut };
