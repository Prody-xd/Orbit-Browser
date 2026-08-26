'use strict';

const { Menu, clipboard, shell } = require('electron');

/**
 * Menus contextuales nativos.
 *
 * Se hacen con `Menu` de Electron y no con HTML a proposito: la pagina es una
 * vista nativa compuesta por encima del chrome, asi que un menu hecho en HTML
 * quedaria tapado por la propia pagina. Los menus nativos flotan sobre todo.
 */

/** Menu al hacer clic derecho dentro de una pagina. */
function showPageMenu({ tabs, tabId, params, window }) {
  const items = [];
  const wc = tabs.tabs.get(tabId)?.view?.webContents;

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
    { label: 'Atrás', enabled: Boolean(wc?.navigationHistory?.canGoBack()), click: () => tabs.goBack(tabId) },
    { label: 'Adelante', enabled: Boolean(wc?.navigationHistory?.canGoForward()), click: () => tabs.goForward(tabId) },
    { label: 'Recargar', click: () => tabs.reload(tabId) },
    { type: 'separator' },
    { label: 'Copiar dirección de la página', click: () => clipboard.writeText(tabs.tabs.get(tabId)?.url ?? '') },
    { label: 'Dormir esta pestaña', click: () => tabs.sleep(tabId, { force: true }) },
    { type: 'separator' },
    { label: 'Inspeccionar', click: () => wc?.openDevTools({ mode: 'detach' }) },
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

function truncate(text, max) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

module.exports = { showPageMenu, showTabMenu };
